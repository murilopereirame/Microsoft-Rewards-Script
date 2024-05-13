import cluster from "cluster";
import { BrowserContext, Page } from "playwright";

import Browser from "./browser/Browser";
import BrowserFunc from "./browser/BrowserFunc";
import BrowserUtil from "./browser/BrowserUtil";

import { log } from "./util/Logger";
import Util from "./util/Utils";
import { loadAccounts, loadConfig, saveSessionData } from "./util/Load";

import { Login } from "./functions/Login";
import { Workers } from "./functions/Workers";
import Activities from "./functions/Activities";

import { Account } from "./interface/Account";
import { exec } from "child_process";
import { promisify } from "util";
import cron from "node-cron";
import { Config } from "./interface/Config";

// Main bot class
export class MicrosoftRewardsBot {
  public log: typeof log;
  public config;
  public utils: Util;
  public activities: Activities = new Activities(this);
  public browser: {
    func: BrowserFunc;
    utils: BrowserUtil;
  };
  public isMobile: boolean = false;
  public homePage!: Page;

  private collectedPoints: number = 0;
  private earnablePoints: number = 0;
  private availablePoints: number = 0;
  private activeWorkers: number;
  private browserFactory: Browser = new Browser(this);
  private accounts: Account[];
  private workers: Workers;
  private login = new Login(this);

  constructor(config: Config) {
    this.log = log;

    this.accounts = [];
    this.utils = new Util();
    this.workers = new Workers(this);
    this.browser = {
      func: new BrowserFunc(this),
      utils: new BrowserUtil(this),
    };
    this.config = config;
    this.activeWorkers = this.config.clusters;
  }

  async initialize() {
    this.accounts = loadAccounts();
  }

  async run() {
    log("MAIN", `Bot started with ${this.config.clusters} clusters`);

    // Only cluster when there's more than 1 cluster demanded
    if (this.config.clusters > 1) {
      if (cluster.isPrimary) {
        this.runMaster();
      } else {
        this.runWorker();
      }
    } else {
      this.runTasks(this.accounts);
    }
  }

  private runMaster() {
    log("MAIN-PRIMARY", "Primary process started");

    const accountChunks = this.utils.chunkArray(
      this.accounts,
      this.config.clusters
    );

    for (let i = 0; i < accountChunks.length; i++) {
      const worker = cluster.fork();
      const chunk = accountChunks[i];
      worker.send({ chunk });
    }

    cluster.on("exit", (worker, code) => {
      this.activeWorkers -= 1;

      log(
        "MAIN-WORKER",
        `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`,
        "warn"
      );

      // Check if all workers have exited
      if (this.activeWorkers === 0) {
        log(
          "MAIN-WORKER",
          "All workers destroyed. Exiting main process!",
          "warn"
        );
      }
    });
  }

  private runWorker() {
    log("MAIN-WORKER", `Worker ${process.pid} spawned`);
    // Receive the chunk of accounts from the master
    process.on("message", async ({ chunk }) => {
      await this.runTasks(chunk);
    });
  }

  private async runTasks(accounts: Account[]) {
    for (const account of accounts) {
      log("MAIN-WORKER", `Started tasks for account ${account.email}`);

      // Desktop Searches, DailySet and More Promotions
      await this.Desktop(account);

      // If runOnZeroPoints is false and 0 points to earn, stop and try the next account
      if (!this.config.runOnZeroPoints && this.collectedPoints === 0) {
        continue;
      }

      // Mobile Searches
      await this.Mobile(account);

      log("MAIN-WORKER", `Completed tasks for account ${account.email}`);
      await this.runPostSuccess(account.email);
    }

    log("MAIN-PRIMARY", "Completed tasks for ALL accounts");
    log("MAIN-PRIMARY", "All workers destroyed!");
  }

  // Desktop
  async Desktop(account: Account) {
    this.isMobile = false;

    const browser = await this.browserFactory.createBrowser(
      account.proxy,
      account.email
    );
    this.homePage = await browser.newPage();

    log("MAIN", "Starting DESKTOP browser");

    // Login into MS Rewards, then go to rewards homepage
    let login = await this.login.login(
      this.homePage,
      account.email,
      account.password
    );
    let loginRetries = 0;

    while (!login && loginRetries < this.config.maxLoginRetries) {
      await this.login.login(this.homePage, account.email, account.password);
      loginRetries++;
    }

    if (!login) {
      await this.runPostFail(account.email, "Login failed");
      return await this.closeBrowser(browser, account.email);
    }

    await this.browser.func.goHome(this.homePage);

    const data = await this.browser.func.getDashboardData();
    log(
      "MAIN-POINTS",
      `Current point count: ${data.userStatus.availablePoints}`
    );

    this.availablePoints = data.userStatus.availablePoints;

    const earnablePoints = await this.browser.func.getEarnablePoints();
    this.collectedPoints = earnablePoints;
    this.earnablePoints = earnablePoints;
    log("MAIN-POINTS", `You can earn ${earnablePoints} points today`);

    // If runOnZeroPoints is false and 0 points to earn, don't continue
    if (!this.config.runOnZeroPoints && this.collectedPoints === 0) {
      log(
        "MAIN",
        'No points to earn and "runOnZeroPoints" is set to "false", stopping!'
      );

      // Close desktop browser
      return await this.closeBrowser(browser, account.email);
    }

    // Open a new tab to where the tasks are going to be completed
    const workerPage = await browser.newPage();

    // Go to homepage on worker page
    await this.browser.func.goHome(workerPage);

    // Complete daily set
    if (this.config.workers.doDailySet) {
      await this.workers.doDailySet(workerPage, data);
    }

    // Complete more promotions
    if (this.config.workers.doMorePromotions) {
      await this.workers.doMorePromotions(workerPage, data);
    }

    // Complete punch cards
    if (this.config.workers.doPunchCards) {
      await this.workers.doPunchCard(workerPage, data);
    }

    // Do desktop searches
    if (this.config.workers.doDesktopSearch) {
      await this.activities.doSearch(workerPage, data);
    }

    // Save cookies
    await saveSessionData(
      this.config.sessionPath,
      browser,
      account.email,
      this.isMobile
    );

    // Close desktop browser
    await this.closeBrowser(browser, account.email);
    return;
  }

  // Mobile
  async Mobile(account: Account) {
    this.isMobile = true;

    const browser = await this.browserFactory.createBrowser(
      account.proxy,
      account.email
    );
    this.homePage = await browser.newPage();

    log("MAIN", "Starting MOBILE browser");

    // Login into MS Rewards, then go to rewards homepage
    await this.login.login(this.homePage, account.email, account.password);
    await this.browser.func.goHome(this.homePage);

    const data = await this.browser.func.getDashboardData();

    // If no mobile searches data found, stop (Does not exist on new accounts)
    if (!data.userStatus.counters.mobileSearch) {
      log("MAIN", "No mobile searches found, stopping!");

      // Close mobile browser
      return await this.closeBrowser(browser, account.email);
    }

    // Open a new tab to where the tasks are going to be completed
    const workerPage = await browser.newPage();

    // Go to homepage on worker page
    await this.browser.func.goHome(workerPage);

    // Do mobile searches
    if (this.config.workers.doMobileSearch) {
      await this.activities.doSearch(workerPage, data);

      // Fetch current search points
      const mobileSearchPoints = (await this.browser.func.getSearchPoints())
        .mobileSearch?.[0];

      // If the remaining mobile points does not equal 0, restart and assume the generated UA is invalid
      // Retry until all points are gathered when (retryMobileSearch is enabled)
      if (
        this.config.searchSettings.retryMobileSearch &&
        mobileSearchPoints &&
        mobileSearchPoints.pointProgressMax - mobileSearchPoints.pointProgress >
          0
      ) {
        log(
          "MAIN",
          "Unable to complete mobile searches, bad User-Agent? Retrying..."
        );

        // Close mobile browser
        await this.closeBrowser(browser, account.email);

        // Retry
        await this.Mobile(account);
      }
    }

    // Fetch new points
    const earnablePoints = await this.browser.func.getEarnablePoints();

    // If the new earnable is 0, means we got all the points, else retract
    this.collectedPoints =
      earnablePoints === 0
        ? this.collectedPoints
        : this.collectedPoints - earnablePoints;
    log(
      "MAIN-POINTS",
      `The script collected ${this.collectedPoints} points today`
    );

    // Close mobile browser
    await this.closeBrowser(browser, account.email);
    return;
  }

  private async closeBrowser(browser: BrowserContext, email: string) {
    // Save cookies
    await saveSessionData(
      this.config.sessionPath,
      browser,
      email,
      this.isMobile
    );

    // Close browser
    await browser.close();
  }

  private async runPostSuccess(email: string) {
    log("POST-SUCCESS", `Running success post action for ${email}`);
    if (this.config.postSuccess) {
      const runner = promisify(exec);
      const { stdout } = await runner(
        this.config.postSuccess
          .replace("{collected}", this.collectedPoints.toString())
          .replace("{earnablePoints}", this.earnablePoints.toString())
          .replace("{initialBalance}", this.availablePoints.toString())
          .replace(
            "{newBalance}",
            (this.availablePoints + this.collectedPoints).toString()
          )
          .replace("{email}", email)
      );
      log("POST-SUCCESS", `Post success action runned for ${email}`);
      return log("POST-SUCCESS", `STDOUT ${stdout}`);
    }
    return log("POST-SUCCESS", `Post success action failed for ${email}`);
  }

  private async runPostFail(email: string, error: string) {
    log("POST-FAIL", `Running fail post action for ${email}`);
    if (this.config.postFail) {
      const runner = promisify(exec);
      const { stdout } = await runner(
        this.config.postFail.replace("{error}", error).replace("{email}", email)
      );
      log("POST-FAIL", `Post fail action runned for ${email}`);
      return log("POST-FAIL", `STDOUT ${stdout}`);
    }
    return log("POST-FAIL", `Post fail action failed for ${email}`);
  }
}

const runBot = (config: Config) => {
  const bot = new MicrosoftRewardsBot(config);
  // Initialize accounts first and then start the bot
  bot.initialize().then(() => {
    bot.run();
  });
};

const randomMs = (min: number, max: number) => {
  return Math.floor(Math.random() * (max - min + 1) + min);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const config = loadConfig();

if (config.cronExpr) {
  cron.schedule(config.cronExpr, async () => {
    const timeToSleep = randomMs(
      config.minimumWaitTime,
      config.maximumWaitTime
    );

    await sleep(timeToSleep);

    runBot(config);
  });
} else {
  runBot(config);
}
