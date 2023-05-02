export type flowObj = {
  name: string;
  metadata?: {
    author: string;
    created: number;
  };
  steps: string[];
  processors: Record<
    string,
    {
      className: string;
      config: Record<string, any>;
    }
  >;
  consoleFilter: {
    trace: boolean;
    debug: boolean;
    info: boolean;
    warn: boolean;
    error: boolean;
    other: boolean;
    forceStreams: boolean;
    sendToCentralReporter: boolean;
    summarizeToCentral: boolean;
    saveStateToDb: boolean;
    synchronous: boolean;
    consoleMessageSynchronous: boolean;
    logPayload: boolean;
    logEnd: boolean;
    logMiddle: boolean;
    logStart: boolean;
    inMemoryConsoleLimit: number;
  };
  description: string;
};

export type configObj = {
  referenceId: string;
  metadata: {
    author: string;
    created: number;
    modified: number;
  };
  secure: boolean;
  referencedBy: {
    flows: string[];
    statefulBehaviours: [];
    sharedConfigs: string[];
  };
  config?: any; //use { "referenceString": "name_of_reference" } for referencing other configs
  redactedConfig?: "hidden";
};

export type resourceObj = {
  collectionId: string;
  metadata?: {
    author: string;
    created: number;
    modified?: number;
  };
  resources: {
    resourceId: string;
    resourceCollectionId: string;
    resourceStatusCode: number;
    resourceAccessorPath: string;
    resourceAccessorMethod: "GET" | "POST" | "PUT" | "DELETE";
    resourceAccessorHeaders: [string, string][];
    resourceStateful: boolean;
    resourceHeaders: [string, string][];
    resourceBytes: string;
    resourceDescription: string;
  }[];
};

export type triggerObj = cron | dbQueue | dnsOverride | http | timer;

interface trigBase {
  metadata?: {
    author: string;
    created: number;
    modified?: number;
  };
}

interface awsSQS extends trigBase {
  classPath: "awsSQS";
  config: {};
}

interface cron extends trigBase {
  classPath: "cron";
  config: {
    runOnlyOnRanks: [];
    name: string;
    mutualReentrancyKey: null;
    description: string;
    timezone: string;
    nonReentrant: boolean;
    orchestratorName: string;
    id: string;
    runOnlyOnHosts: [];
    isRunning: boolean;
    killOnStop: boolean;
    orchestrationTimeout: number;
    cronExpression: string;
  };
}

interface dbQueue extends trigBase {
  classPath: "dbQueue";
  config: {
    maintainBatches: boolean;
    runOnlyOnRanks: [];
    name: string;
    delay: number;
    mutualReentrancyKey: null;
    queue: string;
    description: string;
    nonReentrant: boolean;
    orchestratorName: string;
    id: string;
    runOnlyOnHosts: [];
    isRunning: boolean;
    killOnStop: boolean;
    orchestrationTimeout: number;
    implicitAck: boolean;
    maximumBatchSize: number;
    pollInterval: number;
  };
}

interface dnsOverride extends trigBase {
  classPath: "dnsOverride";
  config: {
    runOnlyOnRanks: [];
    name: string;
    description: string;
    host: string;
    id: string;
    isIPv6: boolean;
    ipAddress: string;
    runOnlyOnHosts: [];
    isRunning: boolean;
  };
}

interface googlePubSub extends trigBase {
  classPath: "googlePubSub";
  config: {};
}

interface http extends trigBase {
  classPath: "http";
  config: {
    runOnlyOnRanks: [];
    name: string;
    mutualReentrancyKey: string;
    path: string;
    authTimeout: number;
    description: string;
    stateful: boolean;
    poolSize: number;
    nonReentrant: boolean;
    orchestratorName: string;
    outputTransformerFunc: null;
    immutable: boolean;
    id: string;
    simpleTransformerFunc: null;
    simple: boolean;
    authenticationFlow: null;
    runOnlyOnHosts: [];
    isRunning: boolean;
    killOnStop: boolean;
    orchestrationTimeout: number;
  };
}

interface httpRedirector extends trigBase {
  classPath: "httpRedirector";
  config: {};
}

interface memQueue extends trigBase {
  classPath: "memQueue";
  config: {};
}

interface onBoot extends trigBase {
  classPath: "onBoot";
  config: {};
}

interface onShutdown extends trigBase {
  classPath: "onShutdown";
  config: {};
}

interface reverseProxy extends trigBase {
  classPath: "reverseProxy";
  config: {};
}

interface sshLocalTunnel extends trigBase {
  classPath: "sshLocalTunnel";
  config: {};
}

interface sshRemoteTunnel extends trigBase {
  classPath: "sshRemoteTunnel";
  config: {};
}

interface statefulReverseProxy extends trigBase {
  classPath: "statefulReverseProxy";
  config: {};
}

interface timer extends trigBase {
  classPath: "timer";
  config: {
    runOnlyOnRanks: [];
    name: string;
    delay: null;
    mutualReentrancyKey: null;
    description: string;
    nonReentrant: boolean;
    orchestratorName: string;
    id: string;
    runOnlyOnHosts: [];
    isRunning: boolean;
    killOnStop: boolean;
    orchestrationTimeout: number;
    period: number;
  };
}

export type optionType = flowObj | configObj | triggerObj | resourceObj;
