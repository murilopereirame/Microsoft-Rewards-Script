import cluster from 'cluster'
import { Page } from 'rebrowser-playwright'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtil from './browser/BrowserUtil'

import {log} from './util/Logger'
import Util from './util/Utils'
import {loadAccounts, loadConfig, saveSessionData} from './util/Load'

import {Login} from './functions/Login'
import {Workers} from './functions/Workers'
import Activities from './functions/Activities'

import { Account } from './interface/Account'
import { exec } from 'child_process'
import { promisify } from 'util'
import Axios from './util/Axios'
import cron from 'node-cron'

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof log
    public config
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }
    public isMobile: boolean
    public homePage!: Page

    private pointsCanCollect: number = 0
    private pointsInitial: number = 0
    private activeWorkers: number
    private collectedPoints: number = 0
    private earnablePoints: number = 0
    private availablePoints: number = 0
    private mobileRetryAttempts: number
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)
    private accessToken: string = ''

    //@ts-expect-error Will be initialized later
    public axios: Axios

    constructor(isMobile: boolean) {
        this.isMobile = isMobile
        this.log = log

        this.accounts = []
        this.utils = new Util()
        this.workers = new Workers(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
        this.mobileRetryAttempts = 0
    }

    async initialize() {
        this.accounts = loadAccounts()
    }

    async run() {
        log('main', 'MAIN', `Bot started with ${this.config.clusters} clusters`)

        // Only cluster when there's more than 1 cluster demanded
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.runMaster()
            } else {
                this.runWorker()
            }
        } else {
            await this.runTasks(this.accounts)
        }
    }

    private runMaster() {
        log('main', 'MAIN-PRIMARY', 'Primary process started')

        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]
            worker.send({chunk})
        }

        cluster.on('exit', (worker, code) => {
            this.activeWorkers -= 1

            log('main', 'MAIN-WORKER', `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                log('main', 'MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })
    }

    private runWorker() {
        log('main', 'MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts from the master
        process.on('message', async ({chunk}) => {
            await this.runTasks(chunk)
        })
    }

    private async runTasks(accounts: Account[]) {
        for (const account of accounts) {
            log('main', 'MAIN-WORKER', `Started tasks for account ${account.email}`)

            this.axios = new Axios(account.proxy)
            if (this.config.parallel) {
                await Promise.all([
                    this.Desktop(account),
                    (() => {
                        const mobileInstance = new MicrosoftRewardsBot(true)
                        mobileInstance.axios = this.axios

                        return mobileInstance.Mobile(account)
                    })()
                ])
            } else {
                this.isMobile = false
                await this.Desktop(account)

                this.isMobile = true
                await this.Mobile(account)
            }

            log('main', 'MAIN-WORKER', `Completed tasks for account ${account.email}`)
            await this.runPostSuccess(account.email)
        }

        log(this.isMobile, 'MAIN-PRIMARY', 'Completed tasks for ALL accounts', 'log', 'green')
        process.exit()
    }

    // Desktop
    async Desktop(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
        this.homePage = await browser.newPage()

        log(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)
        let login = await this.login.login(this.homePage, account.email, account.password)
        this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

        let loginRetries = 0

        while (!login.status && loginRetries < this.config.maxLoginRetries) {
            login = await this.login.login(this.homePage, account.email, account.password)
            loginRetries++
        }

        if (!login.status) {
            const message = login.reason === 'GENERIC' ? 'Login failed with generic error' : 'Account locked'
            await this.runPostFail(account.email, message)
            return await this.browser.func.closeBrowser(browser, account.email)
        }

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        this.pointsInitial = data.userStatus.availablePoints

        log(this.isMobile, 'MAIN-POINTS', `Current point count: ${this.pointsInitial}`)

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()
        const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken)

        const earnablePoints = browserEnarablePoints.totalEarnablePoints + appEarnablePoints.totalEarnablePoints
        this.collectedPoints = earnablePoints
        this.earnablePoints = earnablePoints
        this.availablePoints = data.userStatus.availablePoints
        log('main', 'MAIN-POINTS', `You can earn ${earnablePoints} points today (Browser: ${browserEnarablePoints} points, App: ${appEarnablePoints} points)`)
        // Tally all the desktop points
        this.pointsCanCollect = browserEnarablePoints.dailySetPoints +
            browserEnarablePoints.desktopSearchPoints
            + browserEnarablePoints.morePromotionsPoints

        log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

            // Close desktop browser
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        // Open a new tab to where the tasks are going to be completed
        const workerPage = await browser.newPage()

        // Go to homepage on worker page
        await this.browser.func.goHome(workerPage)

        // Complete daily set
        if (this.config.workers.doDailySet) {
            try {
                await this.workers.doDailySet(workerPage, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete daily set ${e}`)
            }
        }

        // Complete more promotions
        if (this.config.workers.doMorePromotions) {
            try {
                await this.workers.doMorePromotions(workerPage, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete do more ${e}`)
            }
        }

        // Complete punch cards
        if (this.config.workers.doPunchCards) {
            try {
                await this.workers.doPunchCard(workerPage, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete punch cards ${e}`)
            }
        }

        // Do desktop searches
        if (this.config.workers.doDesktopSearch) {
            try {
                await this.activities.doSearch(workerPage, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete desktop search ${e}`)
            }
        }

        // Save cookies
        await saveSessionData(this.config.sessionPath, browser, account.email, this.isMobile)

        // Close desktop browser
        await this.browser.func.closeBrowser(browser, account.email)
        return
    }

    // Mobile
    async Mobile(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.proxy, account.email)
        this.homePage = await browser.newPage()

        log(this.isMobile, 'MAIN', 'Starting browser')

        // Login into MS Rewards, then go to rewards homepage
        await this.login.login(this.homePage, account.email, account.password)
        this.accessToken = await this.login.getMobileAccessToken(this.homePage, account.email)

        await this.browser.func.goHome(this.homePage)

        const data = await this.browser.func.getDashboardData()

        const browserEnarablePoints = await this.browser.func.getBrowserEarnablePoints()
        const appEarnablePoints = await this.browser.func.getAppEarnablePoints(this.accessToken)

        this.pointsCanCollect = browserEnarablePoints.mobileSearchPoints + appEarnablePoints.totalEarnablePoints

        log(this.isMobile, 'MAIN-POINTS', `You can earn ${this.pointsCanCollect} points today (Browser: ${browserEnarablePoints.mobileSearchPoints} points, App: ${appEarnablePoints.totalEarnablePoints} points)`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.pointsCanCollect === 0) {
            log(this.isMobile, 'MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping!', 'log', 'yellow')

            // Close mobile browser
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }

        // Do daily check in
        if (this.config.workers.doDailyCheckIn) {
            try {
                await this.activities.doDailyCheckIn(this.accessToken, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete daily check in ${e}`)
            }
        }

        // Do read to earn
        if (this.config.workers.doReadToEarn) {
            try {
                await this.activities.doReadToEarn(this.accessToken, data)
            } catch (e) {
                log('main', 'MAIN', `Failed to complete read to earn ${e}`)
            }
        }

        // Do mobile searches
        if (this.config.workers.doMobileSearch) {
            // If no mobile searches data found, stop (Does not always exist on new accounts)
            if (data.userStatus.counters.mobileSearch) {
                // Open a new tab to where the tasks are going to be completed
                const workerPage = await browser.newPage()

                // Go to homepage on worker page
                await this.browser.func.goHome(workerPage)

                // Do mobile searches
                if (this.config.workers.doMobileSearch) {
                    try {
                        await this.activities.doSearch(workerPage, data)

                        // Fetch current search points
                        const mobileSearchPoints = (await this.browser.func.getSearchPoints()).mobileSearch?.[0]

                        if (mobileSearchPoints && (mobileSearchPoints.pointProgressMax - mobileSearchPoints.pointProgress) > 0) {
                            // Increment retry count
                            this.mobileRetryAttempts++
                        }

                        // Exit if retries are exhausted
                        if (this.mobileRetryAttempts > this.config.searchSettings.retryMobileSearchAmount) {
                            log(this.isMobile, 'MAIN', `Max retry limit of ${this.config.searchSettings.retryMobileSearchAmount} reached. Exiting retry loop`, 'warn')
                        } else if (this.mobileRetryAttempts !== 0) {
                            log(this.isMobile, 'MAIN', `Attempt ${this.mobileRetryAttempts}/${this.config.searchSettings.retryMobileSearchAmount}: Unable to complete mobile searches, bad User-Agent? Increase search delay? Retrying...`, 'log', 'yellow')

                            // Close mobile browser
                            await this.browser.func.closeBrowser(browser, account.email)

                            // Retry
                            await this.Mobile(account)
                        }
                    } catch (e) {
                        log('main', 'MAIN', `Failed to complete mobile search ${e}`)
                    }
                } else {
                    log(this.isMobile, 'MAIN', 'Unable to fetch search points, your account is most likely too "new" for this! Try again later!', 'warn')
                }
            }

            const afterPointAmount = await this.browser.func.getCurrentPoints()

            log(this.isMobile, 'MAIN-POINTS', `The script collected ${afterPointAmount - this.pointsInitial} points today`)

            // Close mobile browser
            await this.browser.func.closeBrowser(browser, account.email)
            return
        }
    }

    private async runPostSuccess(email: string) {
        log('main', 'POST-SUCCESS', `Running success post action for ${email}`)
        if (this.config.postSuccess) {
            const runner = promisify(exec)
            const {stdout} = await runner(
                this.config.postSuccess
                    .replace('{collected}', this.collectedPoints.toString())
                    .replace('{earnablePoints}', this.earnablePoints.toString())
                    .replace('{initialBalance}', this.availablePoints.toString())
                    .replace('{newBalance}',
                        (this.availablePoints + this.collectedPoints).toString()
                    )
                    .replace('{email}', email)
            )
            log('main', 'POST-SUCCESS', `Post success action runned for ${email}`)
            return log('main', 'POST-SUCCESS', `STDOUT ${stdout}`)
        }
        return log('main', 'POST-SUCCESS', `Post success action failed for ${email}`)
    }

    private async runPostFail(email: string, error: string) {
        log('main', 'POST-FAIL', `Running fail post action for ${email}`)
        if (this.config.postFail) {
            const runner = promisify(exec)
            const {stdout} = await runner(
                this.config.postFail.replace('{error}', error).replace('{email}', email)
            )
            log('main', 'POST-FAIL', `Post fail action runned for ${email}`)
            return log('main', 'POST-FAIL', `STDOUT ${stdout}`)
        }
        return log('main', 'POST-FAIL', `Post fail action failed for ${email}`)
    }
}

async function main() {
    const rewardsBot = new MicrosoftRewardsBot(false)

    try {
        await rewardsBot.initialize()
        await rewardsBot.run()
    } catch (error) {
        log(false, 'MAIN-ERROR', `Error running desktop bot: ${error}`, 'error')
    }
}

const runBot = () => {
    main().catch(error => {
        log('main', 'MAIN-ERROR', `Error running bots: ${error}`, 'error')
    })
}

const randomMs = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1) + min)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const config = loadConfig()

if (config.cronExpr) {
    log('main', 'MAIN', `Rewards collection scheduled according to ${config.cronExpr}`)
    cron.schedule(config.cronExpr, async () => {
        const timeToSleep = randomMs(
            config.minimumWaitTime,
            config.maximumWaitTime
        )

        log('main', 'MAIN', `Sleeping ${timeToSleep} before running`)

        await sleep(timeToSleep)

        runBot()
    })

    if (config.runOnStart) {
        runBot()
    }
} else {
    runBot()
}