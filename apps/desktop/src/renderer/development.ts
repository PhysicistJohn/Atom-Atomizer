type DevelopmentImportMeta = ImportMeta & {
  readonly env?: {
    readonly DEV?: boolean;
  };
};

/** Build-time Vite flag, isolated so shared renderer components remain portable. */
export const DEVELOPMENT_RENDERER = (import.meta as DevelopmentImportMeta).env?.DEV === true;
