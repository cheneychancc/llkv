import {
  ChannelId,
  FoxgloveClient,
  ServerCapability,
  SubscriptionId,
  ServiceCallPayload,
  ServiceCallRequest,
  ServiceCallResponse,
  Parameter,
  StatusLevel,
  FetchAssetStatus,
  FetchAssetResponse,
  BinaryOpcode,
} from "@foxglove/ws-protocol";

import {
  AdvertiseOptions,
  MessageEvent,
  Player,
  PlayerMetricsCollectorInterface,
  PlayerPresence,
  PlayerAlert,
  PlayerState,
  PublishPayload,
  SubscribePayload,
  Topic,
  TopicStats,
} from "@lichtblick/suite-base/players/types";
import {
  fromMillis,
  fromNanoSec,
  isGreaterThan,
  isLessThan,
  subtract,
  Time,
} from "@lichtblick/rostime";

import { v4 as uuidv4 } from "uuid";
import { ParameterValue } from "@lichtblick/suite";
import { Asset } from "@lichtblick/suite-base/components/PanelExtensionAdapter";
import PlayerAlertManager from "@lichtblick/suite-base/players/PlayerAlertManager";
import { PLAYER_CAPABILITIES } from "@lichtblick/suite-base/players/constants";
import { estimateObjectSize } from "@lichtblick/suite-base/players/messageMemoryEstimation";
import {
  MessageWriter,
  MessageDefinitionMap,
  Publication,
  ResolvedChannel,
  ResolvedService,
} from "./types";

import WorkerSocketAdapter from "./WorkerSocketAdapter";

export default class FoxgloveWebSocketPlayer implements Player {
  readonly #sourceId: string;

  #url: string; // WebSocket URL.
  #name: string;
  #client?: FoxgloveClient; // The client when we're connected.
  #id: string = uuidv4(); // Unique ID for this player session.
  #serverCapabilities: string[] = [];
  #playerCapabilities: (typeof PLAYER_CAPABILITIES)[keyof typeof PLAYER_CAPABILITIES][] = [];
  #supportedEncodings?: string[];
  #listener?: (arg0: PlayerState) => Promise<void>; // Listener for _emitState().
  #closed: boolean = false; // Whether the player has been completely closed using close().
  #topics?: Topic[]; // Topics as published by the WebSocket.
  #topicsStats = new Map<string, TopicStats>(); // Topic names to topic statistics.
  #datatypes: MessageDefinitionMap = new Map(); // Datatypes as published by the WebSocket.
  #parsedMessages: MessageEvent[] = []; // Queue of messages that we'll send in next _emitState() call.
  #parsedMessagesBytes: number = 0;
  #receivedBytes: number = 0;
  #metricsCollector: PlayerMetricsCollectorInterface;
  #presence: PlayerPresence = PlayerPresence.INITIALIZING;
  #alerts = new PlayerAlertManager();
  #numTimeSeeks = 0;
  #profile?: string;
  #urlState: PlayerState["urlState"];

  /** Earliest time seen */
  #startTime?: Time;
  /** Latest time seen */
  #endTime?: Time;
  /* The most recent published time, if available */
  #clockTime?: Time;
  /* Flag indicating if the server publishes time messages */
  #serverPublishesTime = false;

  #unresolvedSubscriptions = new Set<string>();
  #resolvedSubscriptionsByTopic = new Map<string, SubscriptionId>();
  #resolvedSubscriptionsById = new Map<SubscriptionId, ResolvedChannel>();
  #channelsByTopic = new Map<string, ResolvedChannel>();
  #channelsById = new Map<ChannelId, ResolvedChannel>();
  #unsupportedChannelIds = new Set<ChannelId>();
  #recentlyCanceledSubscriptions = new Set<SubscriptionId>();
  #parameters = new Map<string, ParameterValue>();
  #getParameterInterval?: ReturnType<typeof setInterval>;
  #openTimeout?: ReturnType<typeof setInterval>;
  #connectionAttemptTimeout?: ReturnType<typeof setInterval>;
  #unresolvedPublications: AdvertiseOptions[] = [];
  #publicationsByTopic = new Map<string, Publication>();
  #serviceCallEncoding?: string;
  #servicesByName = new Map<string, ResolvedService>();
  #serviceResponseCbs = new Map<
    ServiceCallRequest["callId"],
    (response: ServiceCallResponse) => void
  >();
  #publishedTopics?: Map<string, Set<string>>;
  #subscribedTopics?: Map<string, Set<string>>;
  #advertisedServices?: Map<string, Set<string>>;
  #nextServiceCallId = 0;
  #nextAssetRequestId = 0;
  #fetchAssetRequests = new Map<number, (response: FetchAssetResponse) => void>();
  #fetchedAssets = new Map<string, Promise<Asset>>();
  #parameterTypeByName = new Map<string, Parameter["type"]>();
  #messageSizeEstimateByTopic: Record<string, number> = {};
  #ishighFrequencyMessage = false;

  public constructor({
    url,
    metricsCollector,
    sourceId,
  }: {
    url: string;
    metricsCollector: PlayerMetricsCollectorInterface;
    sourceId: string;
  }) {
    this.#metricsCollector = metricsCollector;
    this.#url = url;
    this.#name = url;
    this.#metricsCollector.playerConstructed();
    this.#sourceId = sourceId;
    this.#urlState = {
      sourceId: this.#sourceId,
      parameters: { url: this.#url },
    };
    this.#open();
  }

  #open = (): void => {
    if (this.#closed) {
      return;
    }
    if (this.#client != undefined) {
      throw new Error(`Attempted to open a second Foxglove WebSocket connection`);
    }
    console.info(`Opening connection to ${this.#url}`);

    // 1. 初始化客户端 (先强制用原生的 WebSocket 保证链路通畅)
    const subprotocols = [FoxgloveClient.SUPPORTED_SUBPROTOCOL, "foxglove.sdk.v1"];
    this.#client = new FoxgloveClient({
      ws: new WebSocket(this.#url, subprotocols),
    });

    // 2. 绑定核心事件监听
    this.#client.on("open", () => {
      console.log("✅ WebSocket 已连接");
      this.#presence = PlayerPresence.INITIALIZING;
    });

    this.#client.on("serverInfo", (event) => {
      console.log("ℹ️ 收到服务器信息:", event.name);
      this.#serverCapabilities = event.capabilities ?? [];
      this.#presence = PlayerPresence.PRESENT;
      // 触发一次状态更新（稍后实现）
    });

    this.#client.on("error", (err) => {
      console.error("❌ WebSocket 错误:", err);
    });

    this.#client.on("close", (event) => {
      console.warn("⚠️ 连接已关闭:", event.reason);
      this.#presence = PlayerPresence.INITIALIZING;
    });

    // 3. 监听频道（话题）发现
    this.#client.on("advertise", (newChannels) => {
      console.log(`📣 发现 ${newChannels.length} 个新话题`);

      if (!this.#client) {
        return;
      }

      // for (const topic of this.#unresolvedSubscriptions) {
      //   const chanInfo = this.#channelsByTopic.get(topic);
      //   if (chanInfo) {
      //     const subId = this.#client.subscribe(chanInfo.channel.id);
      //     this.#unresolvedSubscriptions.delete(topic);
      //     this.#resolvedSubscriptionsByTopic.set(topic, subId);
      //     this.#resolvedSubscriptionsById.set(subId, chanInfo);
      //   }
      // }
      // 记录频道信息 (ID -> Topic)
      for (const ch of newChannels) {
        this.#channelsById.set(ch.id, {
          id: ch.id,
          topic: ch.topic,
          encoding: ch.encoding,
          schemaName: ch.schemaName,
          // schema: ch.schema (这里如果是 Protobuf 需要进一步处理)
        });
      }
      console.log('频道信息：', newChannels)
      // 关键：为了看到数据，我们要主动订阅
      const ids = newChannels.map(c => c.id);
      this.#client?.subscribe(ids);
      console.log("📤 已发送订阅请求:", ids);
    });
    this.#client.on("status", (status) => {
      console.log("🔔 收到服务器状态更新:", status);
    });
    // 4. 监听原始消息
    this.#client.on("message", ({ subscriptionId, data }) => {
       // 这里的 data 是 ArrayBuffer
       console.log(`📦 收到数据包! ID: ${subscriptionId}, 大小: ${data.byteLength} bytes`);
    });
  };
  // #open = (): void => {
  //   if (this.#closed) {
  //     return;
  //   }
  //   if (this.#client != undefined) {
  //     throw new Error(`Attempted to open a second Foxglove WebSocket connection`);
  //   }
  //   console.info(`Opening connection to ${this.#url}`);

  //   // Set a timeout to abort the connection if we are still not connected by then.
  //   // This will abort hanging connection attempts that can for whatever reason not
  //   // establish a connection with the server.
  //   this.#connectionAttemptTimeout = setTimeout(() => {
  //     this.#client?.close();
  //   }, 10000);

  //   const subprotocols = [FoxgloveClient.SUPPORTED_SUBPROTOCOL, "foxglove.sdk.v1"];

  //   this.#client = new FoxgloveClient({
  //     ws:
  //       typeof Worker !== "undefined"
  //         ? new WorkerSocketAdapter(this.#url, subprotocols)
  //         : new WebSocket(this.#url, subprotocols),
  //   });

  //   this.#client.on("open", () => {});

  //   this.#client.on("error", (err) => {});

  //   // Note: We've observed closed being called not only when an already open connection is closed
  //   // but also when a new connection fails to open
  //   //
  //   // Note: We explicitly avoid clearing state like start/end times, datatypes, etc to preserve
  //   // this during a disconnect event. Any necessary state clearing is handled once a new connection
  //   // is established
  //   this.#client.on("close", (event) => {});

  //   this.#client.on("serverInfo", (event) => {});

  //   this.#client.on("status", (event) => {});

  //   this.#client.on("advertise", (newChannels) => {});

  //   this.#client.on("unadvertise", (removedChannels) => {});

  //   this.#client.on("message", ({ subscriptionId, data }) => {});

  //   this.#client.on("time", ({ timestamp }) => {});

  //   this.#client.on("parameterValues", ({ parameters, id }) => {});

  //   this.#client.on("advertiseServices", (services) => {});

  //   this.#client.on("unadvertiseServices", (serviceIds) => {});

  //   this.#client.on("serviceCallResponse", (response) => {});

  //   this.#client.on("connectionGraphUpdate", (event) => {});

  //   this.#client.on("fetchAssetResponse", (response) => {});
  // };

  #updateTopicsAndDatatypes() {}

  // Potentially performance-sensitive; await can be expensive
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  // #emitState = debouncePromise(() => {});

  public setListener() {}

  public close(): void {}

  public setSubscriptions() {}

  #processUnresolvedSubscriptions() {}

  public setPublishers() {}

  public setParameter() {}

  public publish(){}

  public async callService(serviceName: string, request: unknown) {}

  public async fetchAsset(uri: string) {}

  public setGlobalVariables(): void {}

  public getBatchIterator(): undefined {}

  // Return the current time
  //
  // For servers which publish a clock, we return that time. If the server disconnects we continue
  // to return the last known time. For servers which do not publish a clock, we use wall time.
  #getCurrentTime() {}

  #setupPublishers(): void {}

  #advertiseChannel() {}

  #unadvertiseChannel() {}

  #resetSessionState(): void {}

  #updateDataTypes(): void {}
}
