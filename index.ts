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

const response = await fetch('https://www.8a.nu')
const html = await response.text()

const { document } = parseHTML(html)

const newsList = document.querySelector('.news-list')

if (!newsList) {
    throw new Error('Could not find .news-list')
}

const items = newsList.querySelectorAll('.news-item')

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

items.forEach((item) => {
    const image = item.querySelector('.news-image') as HTMLImageElement
    const header = item.querySelector('.news-item-header')
    const content = item.querySelector('.news-content')
    const link = item.querySelector('a')

    console.log(
        `image: ${image ? 'ok' : 'missing'}, header: ${header ? 'ok' : 'missing'
        }, content: ${content ? 'ok' : 'missing'}, link: ${link ? 'ok' : 'missing'
        }`)
    if (!image || !header || !content || !link) {
        return
    }

    feed.addItem({
        title: header.textContent || 'No title',
        id: link.href,
        link: link.href,
        description: content.textContent || 'No content',
        content: content.outerHTML || 'No content',
        image: image.src,
        date: new Date(), // TODO: extract date from the item
    })
})

Bun.write("./dist/rss.xml", feed.rss2())
Bun.write("./dist/feed.json", feed.json1())
Bun.write("./dist/atom.xml", feed.atom1())
