POST /snapshot

{
  "url": "https://www.baidu.com",
  "device": "iPhone X",
  "scrollTimes": 5,
  "scrollDelay": 2,
  'scrollOffset': 1000,
  'readyState': ''
}


{
  startTime: 1650515403849,
  endTime: 1650515405770,
  screenshotId: '701c698b-b9cb-49b4-aaa7-c9efd0f33b07',
  picUrl: 'https://chromesnapshot.oss-cn-huhehaote.aliyuncs.com/701c698b-b9cb-49b4-aaa7-c9efd0f33b07.jpg?OSSAccessKeyId=LTAI5t8wb1fFykzKzCi2pGLi&Expires=1650515416&Signature=1addXECsu1rYTaumJNg9OkwoS5E%3D&x-oss-process=image%2Fresize%2Cm_pad%2Cw_400%2Ch_400'
}

  <!-- url: string,
  device?: string,
  resolution: string,
  scrollTimes: number  
  scrollDelay: number,
  readyState?: PuppeteerLifeCycleEvent, 
  pageTimeout?: number -->



  https://thedavidbarton.github.io/blog/chromium-instances-remain-active-in-the-background-after-browser-disconnect/

  ```javascript
  const puppeteer = require('puppeteer')
const urlArray = require('./urls.json') // contains 3000+ URLs in an array

async function fn() {
  const browser = await puppeteer.launch({ headless: true })
  const browserWSEndpoint = await browser.wsEndpoint()

  for (const url of urlArray) {
    try {
      const browser2 = await puppeteer.connect({ browserWSEndpoint })
      const page = await browser2.newPage()
      await page.goto(url) // in my original code it's also wrapped in a retry function

      // doing cool things with the DOM

      await page.goto('about:blank') // because of you: https://github.com/puppeteer/puppeteer/issues/1490
      await page.close()
      await browser2.disconnect()
    } catch (e) {
      console.error(e)
    }
  }
  await browser.close()
}
fn()
  ```

"捕捉完整的网页，一次滚动即可"
"高质量网页截屏，无需多余步骤"
"让您的网页截屏变得更简单"
"完美捕捉每一张网页图片"
"一键截屏，轻松分享"