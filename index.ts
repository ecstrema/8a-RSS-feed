// a bun script which fetches 8a.nu
// then finds the element with .news-list selector
// then for eache .news-item it contains
//  - extracts the .news-image src and alt
//  - extracts the .news-item-header
//  - extracts the .news-content
//  - extracts the link from the a tag

// Then it generates an rss feed with the extracted data
// The name of the feed is 8a.nu news
// The feed is saved in the root of the project

import { DOMParser, parseHTML } from 'linkedom';
import { Feed } from "@numbered/feed";

const feed = new Feed({
    title: '8a.nu news',
    description: '8a.nu news',
    id: 'https://www.8a.nu',
    link: 'https://www.8a.nu',
    language: 'en',
    image: 'https://www.8a.nu/favicon.png',
    favicon: 'https://www.8a.nu/favicon.png',
    copyright: 'All rights reserved, Vertical Life',
    updated: new Date(),
    generator: "Ecstrema's 8a.nu news feed generator",
    feedLinks: {
        rss: 'https://www.8a.nu/rss.xml',
        json: 'https://www.8a.nu/feed.json',
        atom: 'https://www.8a.nu/atom.xml',
    },
    author: {
        name: 'ecstrema',
        email: 'remimarche@gmail.com',
        link: 'https://ecstrema.com',
    },
})

const response = await fetch('https://www.8a.nu')
const html = await response.text()

const { document } = parseHTML(html)

const newsLists = document.querySelectorAll('.news-list')

async function extractFromItem(item: Element) {
    const link = item.querySelector('a')

    if (!link) {
        console.log("link not found")
        return
    }

    const fullLink = "https://www.8a.nu" + link.href

    const response = await fetch(fullLink)
    const html = await response.text()
    const { document } = parseHTML(html)

    const newsItem = document.querySelector('.news-item')
    const image = newsItem?.querySelector('.news-item-media') as HTMLImageElement
    const date = newsItem?.querySelector('.news-item-header > .news-item-topline')
    const title = newsItem?.querySelector('.news-item-header > h1')
    const content = newsItem?.querySelector('.news-content')

    feed.addItem({
        title: title?.textContent || 'No title',
        id: fullLink,
        link: fullLink,
        description: content?.textContent || 'No content',
        image: image?.src,
        content: content?.outerHTML,
        date: new Date(date?.textContent || Date.now()), // TODO: extract date from the item
    })
}

const promises: Promise<void>[] = []
newsLists.forEach((newsList) => {
    const items = newsList.querySelectorAll('.news-item')

    items.forEach((item) => promises.push(extractFromItem(item)))
})
await Promise.all(promises)

console.log(`found ${feed.items.length} items`)

Bun.write("./dist/rss.xml", feed.rss2())
Bun.write("./dist/feed.json", feed.json1())
Bun.write("./dist/atom.xml", feed.atom1())
