import { PuppeteerLifeCycleEvent } from 'puppeteer-core';

export interface SnapshotOptionDto {
  // url: string;
  device?: string;
  resolution?: string;
  scrollTimes?: number;
  scrollDelay?: number;
  readyState?: PuppeteerLifeCycleEvent;
  pageTimeout?: number;
  scrollOffset?: number;
  debug?: boolean;
  // uploadToOss: string;
}
