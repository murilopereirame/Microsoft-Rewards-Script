import { Page } from 'rebrowser-playwright'
import { platform } from 'os'
import { Workers } from '../Workers'
import { Counters, DashboardData } from '../../interface/DashboardData'
import {log} from "../../util/Logger";

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private searchPageURL = ''

    public async doSearch(page: Page, data: DashboardData) {
        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Starting Bing searches')

        page = await this.bot.browser.utils.getLatestTab(page)

        let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
        let missingPoints = this.calculatePoints(searchCounters)

        if (missingPoints === 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Bing searches have already been completed')
            return
        }

        const geoLocale = data.userProfile.attributes.country || 'ES'
        const language = this.getLanguageFromGeoLocale(geoLocale)

        let searchQueries = await this.getBingTrends(missingPoints, language)
        searchQueries = this.bot.utils.shuffleArray(searchQueries)
        searchQueries = [...new Set(searchQueries)]

        const gainsQueries = await this.getGainsQueries(language)
        searchQueries = searchQueries.concat(gainsQueries)

        await page.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
        await this.bot.utils.wait(2000)
        await this.bot.browser.utils.tryDismissAllMessages(page)

        let maxLoop = 0

        for (let i = 0; i < searchQueries.length; i++) {
            const query = searchQueries[i] as string

            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `${missingPoints} Points Remaining | Query: ${query}`)

            searchCounters = await this.bingSearch(page, query)
            const newMissingPoints = this.calculatePoints(searchCounters)

            if (newMissingPoints == missingPoints) {
                maxLoop++
            } else {
                maxLoop = 0
            }

            missingPoints = newMissingPoints

            if (missingPoints === 0) {
                break
            }

            if (maxLoop > 5 && this.bot.isMobile) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 5 iterations, likely bad User-Agent', 'warn')
                break
            }

            if (maxLoop > 10) {
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search didn\'t gain point for 10 iterations aborting searches', 'warn')
                maxLoop = 0
                break
            }
        }

        if (missingPoints > 0 && this.bot.isMobile) {
            return
        }

        if (missingPoints > 0) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Search completed but we're missing ${missingPoints} points, generating extra searches`)

            let i = 0
            while (missingPoints > 0) {
                const query = searchQueries[i++] as string

                const relatedTerms = await this.getBingSuggestions(query, language)
                if (relatedTerms.length > 3) {
                    for (const term of relatedTerms.slice(1, 3)) {
                        this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', `${missingPoints} Points Remaining | Query: ${term}`)

                        searchCounters = await this.bingSearch(page, term)
                        const newMissingPoints = this.calculatePoints(searchCounters)

                        if (newMissingPoints == missingPoints) {
                            maxLoop++
                        } else {
                            maxLoop = 0
                        }

                        missingPoints = newMissingPoints

                        if (missingPoints === 0) {
                            break
                        }

                        if (maxLoop > 5) {
                            this.bot.log(this.bot.isMobile, 'SEARCH-BING-EXTRA', 'Search didn\'t gain point for 5 iterations aborting searches', 'warn')
                            return
                        }
                    }
                }
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Completed searches')
    }

    private async bingSearch(searchPage: Page, query: string) {
        const platformControlKey = platform() === 'darwin' ? 'Meta' : 'Control'

        for (let i = 0; i < 5; i++) {
            try {
                searchPage = await this.bot.browser.utils.getLatestTab(searchPage)

                await searchPage.evaluate(() => {
                    window.scrollTo(0, 0)
                })

                await this.bot.utils.wait(500)

                const searchBar = '#sb_form_q'
                await searchPage.waitForSelector(searchBar, { state: 'visible', timeout: 10_000 })
                await searchPage.click(searchBar)
                await this.bot.utils.wait(500)
                await searchPage.keyboard.down(platformControlKey)
                await searchPage.keyboard.press('A')
                await searchPage.keyboard.press('Backspace')
                await searchPage.keyboard.up(platformControlKey)
                await searchPage.keyboard.type(query)
                await searchPage.keyboard.press('Enter')

                await this.bot.utils.wait(3000)

                const resultPage = await this.bot.browser.utils.getLatestTab(searchPage)
                this.searchPageURL = new URL(resultPage.url()).href

                await this.bot.browser.utils.reloadBadPage(resultPage)

                if (this.bot.config.searchSettings.scrollRandomResults) {
                    await this.bot.utils.wait(2000)
                    await this.randomScroll(resultPage)
                }

                if (this.bot.config.searchSettings.clickRandomResults) {
                    await this.bot.utils.wait(2002)
                    await this.clickRandomLink(resultPage)
                }

                await this.bot.utils.wait(Math.floor(this.bot.utils.randomNumber(this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.min), this.bot.utils.stringToMs(this.bot.config.searchSettings.searchDelay.max))))

                return await this.bot.browser.func.getSearchPoints()

            } catch (error) {
                if (i === 5) {
                    this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Failed after 5 retries... An error occurred:' + error, 'error')
                    break
                }

                this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed, An error occurred:' + error, 'error')
                this.bot.log(this.bot.isMobile, 'SEARCH-BING', `Retrying search, attempt ${i}/5`, 'warn')

                const lastTab = await this.bot.browser.utils.getLatestTab(searchPage)
                await this.closeTabs(lastTab)

                await this.bot.utils.wait(4000)
            }
        }

        this.bot.log(this.bot.isMobile, 'SEARCH-BING', 'Search failed after 5 retries, ending', 'error')
        return await this.bot.browser.func.getSearchPoints()
    }

    private async getBingTrends(queryCount: number, language: string): Promise<string[]> {
        const queries: string[] = []

        while (queries.length < queryCount) {
            const randomQuery = this.generateRandomQuery()
            const suggestions = await this.getBingSuggestions(randomQuery, language)

            for (const suggestion of suggestions) {
                if (suggestion) {
                    queries.push(suggestion.toLowerCase())

                    if (queries.length >= queryCount) break
                }
            }

            const response = await this.bot.axios.request(request, this.bot.config.proxy.proxyGoogleTrends)
            const rawText = response.data

            const trendsData = this.extractJsonFromResponse(rawText)
            if (!trendsData) {
               throw  this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Failed to parse Google Trends response', 'error')
            }

            const mappedTrendsData = trendsData.map(query => [query[0], query[9]!.slice(1)])
            if (mappedTrendsData.length < 90) {
                this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'Insufficient search queries, falling back to US', 'warn')
                return this.getGoogleTrends()
            }

            for (const [topic, relatedQueries] of mappedTrendsData) {
                queryTerms.push({
                    topic: topic as string,
                    related: relatedQueries as string[]
                })
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-GOOGLE-TRENDS', 'An error occurred:' + error, 'error')
        }

        return queries
    }

    private async getGainsQueries(language: string): Promise<string[]> {
        const gainsQueries: string[] = []

        const suggestions = await this.getBingSuggestions('news', language)
        const filteredSuggestions = suggestions.filter((suggestion): suggestion is string => suggestion !== undefined)

        for (let i = 0; i < 10; i++) {
            if (filteredSuggestions[i] !== undefined) {
                gainsQueries.push(filteredSuggestions[i]!.toLowerCase())
            }
        }

        return gainsQueries
    }

    private generateRandomQuery(): string {
        const randomWords = ['news', 'trends', 'updates', 'latest', 'world', 'technology', 'sports', 'science', 'culture']
        const randomIndex = Math.floor(Math.random() * randomWords.length)
        return randomWords[randomIndex] || 'news'
    }

    private async getBingSuggestions(query: string, language: string): Promise<string[]> {
        try {
            const request = {
                url: `https://api.bing.com/osjson.aspx?query=${query}&mkt=${language}`,
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data[1] as string[]
        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-BING-SUGGESTIONS', 'An error occurred:' + error, 'error')
            return []
        }
    }

    private getLanguageFromGeoLocale(geoLocale: string): string {
        const languageMap: { [key: string]: string } = {
            ES: 'es-ES',
            US: 'en-US',
            FR: 'fr-FR',
            DE: 'de-DE',
            IT: 'it-IT'
        }

        return languageMap[geoLocale] || 'en-US'
    }

    private calculatePoints(counters: Counters) {
        const mobileData = counters.mobileSearch?.[0]
        const genericData = counters.pcSearch?.[0]
        const edgeData = counters.pcSearch?.[1]

        const missingPoints = (this.bot.isMobile && mobileData)
            ? mobileData.pointProgressMax - mobileData.pointProgress
            : (edgeData ? edgeData.pointProgressMax - edgeData.pointProgress : 0)
            + (genericData ? genericData.pointProgressMax - genericData.pointProgress : 0)

        return missingPoints
    }

    private async randomScroll(page: Page) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            await page.evaluate((scrollPos) => {
                window.scrollTo(0, scrollPos)
            }, randomScrollPosition)

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-SCROLL', 'An error occurred:' + error, 'error')
        }
    }

    private async clickRandomLink(page: Page) {
        try {
            await page.click('#b_results .b_algo h2', { timeout: 2000 }).catch(() => { })

            await this.closeContinuePopup(page)

            await this.bot.utils.wait(10_000)

            let lastTab = await this.bot.browser.utils.getLatestTab(page)
            let lastTabURL = new URL(lastTab.url())

            let i = 0
            while (lastTabURL.href !== this.searchPageURL && i < 5) {
                await this.closeTabs(lastTab)

                lastTab = await this.bot.browser.utils.getLatestTab(page)
                lastTabURL = new URL(lastTab.url())
                i++
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-RANDOM-CLICK', 'An error occurred:' + error, 'error')
        }
    }

    private async closeTabs(lastTab: Page) {
        const browser = lastTab.context()
        const tabs = browser.pages()

        try {
            if (tabs.length > 2) {
                await lastTab.close()
                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', `More than 2 were open, closed the last tab: "${new URL(lastTab.url()).host}"`)

            } else if (tabs.length === 1) {
                const newPage = await browser.newPage()
                await this.bot.utils.wait(1000)

                await newPage.goto(this.bingHome)
                await this.bot.utils.wait(3000)
                this.searchPageURL = newPage.url()

                this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'There was only 1 tab open, created a new one')
            } else {
                lastTab = await this.bot.browser.utils.getLatestTab(lastTab)
                await lastTab.goto(this.searchPageURL ? this.searchPageURL : this.bingHome)
            }

        } catch (error) {
            this.bot.log(this.bot.isMobile, 'SEARCH-CLOSE-TABS', 'An error occurred:' + error, 'error')
        }
    }

    private async closeContinuePopup(page: Page) {
        try {
            await page.waitForSelector('#sacs_close', { timeout: 1000 })
            const continueButton = await page.$('#sacs_close')

            if (continueButton) {
                await continueButton.click()
            }
        } catch (error) {
            log('main', 'MAIN', `Failed to close continue popup ${error}`)
        }
    }
}