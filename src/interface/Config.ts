export interface Config {
  baseURL: string;
  sessionPath: string;
  headless: boolean;
  parallel: boolean;
  runOnZeroPoints: boolean;
  clusters: number;
  saveFingerprint: ConfigSaveFingerprint;
  workers: ConfigWorkers;
  searchOnBingLocalQueries: boolean;
  globalTimeout: number | string;
  searchSettings: SearchSettings;
  logExcludeFunc: string[];
  webhooklogExcludeFunc: string[];
  postSuccess: string;
  postFail: string;
  maxLoginRetries: number;
  logFile: string;
  cronExpr: string;
  minimumWaitTime: number;
  maximumWaitTime: number;
}

export interface ConfigSaveFingerprint {
  mobile: boolean;
  desktop: boolean;
  saveFingerprint: boolean;
}

export interface SearchSettings {
  useGeoLocaleQueries: boolean;
  scrollRandomResults: boolean;
  clickRandomResults: boolean;
  searchDelay: ConfigSearchDelay;
  retryMobileSearchAmount: number;
}

export interface ConfigSearchDelay {
  min: number | string;
  max: number | string;
}

export interface ConfigWebhook {
  enabled: boolean;
  url: string;
}

export interface ConfigProxy {
  proxyGoogleTrends: boolean;
  proxyBingTerms: boolean;
}

export interface ConfigWorkers {
  doDailySet: boolean;
  doMorePromotions: boolean;
  doPunchCards: boolean;
  doDesktopSearch: boolean;
  doMobileSearch: boolean;
  doDailyCheckIn: boolean;
  doReadToEarn: boolean;
}
