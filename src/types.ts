// Shapes of the configs the flow server returns, taken from the data in a
// real project. Only the fields pathisync reads are required; every type
// keeps an index signature because the server adds fields over time (for
// example `useVirtualThreads`).

export type Metadata = {
  author: string;
  created: number;
  modified?: number;
};

type Open = { [key: string]: unknown };

export type ProcessorConfig = Open & {
  name?: string;
  id?: string;
  classPath?: string;
  testConfig?: (Open & { id?: string })[];
  userFetchProviderWhenUsingClaims?: (Open & { id?: string }) | null;
};

export type Processor = Open & {
  className?: string;
  config?: ProcessorConfig;
  /** Present instead of `config` when the processor is shared. */
  sharedProcessor?: string;
};

export type FlowObj = Open & {
  name: string;
  metadata?: Metadata;
  steps: string[];
  processors: Record<string, Processor>;
  consoleFilter?: Open;
  description?: string;
  testConfig?: unknown[];
  entityId?: string;
  type?: "flow";
  /** Set when the flow was installed by a Pathify bundle. */
  bundle?: string | null;
};

export type SharedConfigObj = Open & {
  referenceId: string;
  metadata?: Metadata;
  secure: boolean;
  entityId?: string;
  type?: "sharedConfig";
  editBySuperuserOnly?: boolean;
  restrictions?: unknown;
  bundle?: string | null;
  /** Use `{ "referenceString": "name_of_reference" }` to reference other configs. */
  config?: unknown;
  /** The server returns `"hidden"` instead of `config` for secure configs. */
  redactedConfig?: "hidden";
};

export type TriggerConfig = Open & {
  name: string;
  id?: string;
  description?: string;
  orchestratorName?: string;
  bundle?: string | null;
  env?: unknown;
  isRunning?: boolean;
};

export type TriggerObj =
  & Open
  & {
    /** e.g. `http`, `timer`, `cron`, `dbQueue`, `dnsOverride`, `reverseProxy` */
    classPath: string;
    metadata?: Metadata;
    type?: "statefulBehaviour";
    entityId?: string;
    lastRun?: string;
  }
  & (
    | { config: TriggerConfig; invalidConfig?: undefined }
    // The server returns invalid triggers without a `config`.
    | { config?: undefined; invalidConfig: Open & { name: string } }
  );

export type ResourceObj = Open & {
  resourceId: string;
  resourceCollectionId: string;
  resourceStatusCode: number;
  resourceAccessorPath: string;
  resourceAccessorMethod: string;
  resourceAccessorHeaders: [string, string][];
  resourceStateful: boolean;
  resourceHeaders: [string, string][];
  /** Base64 file content. Always `""` in a local `_collection.json`. */
  resourceBytes: string;
  resourceDescription: string;
};

export type CollectionObj = Open & {
  collectionId: string;
  metadata?: Metadata;
  entityId?: string;
  type?: "resourceCollection";
  name?: string;
  description?: string;
  bundle?: string | null;
  resources: ResourceObj[];
};

export type SingleConfig = FlowObj | SharedConfigObj | TriggerObj;
