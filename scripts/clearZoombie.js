const find = require('find-process');
const Redis = require('ioredis');
const redisConn = new Redis();

const detectZoombieProcess = async () => {
  const plist = await find('name', /chrome|node/, false)
  for (p of plist) {
    if (/\/root\/projects\/webspy\/crawler\/jisilu\.js/.test(p.cmd) || p.name === 'chrome') {
      const isExist = await redisConn.exist(`ZOOMBIEE:${p.pid}`)
      if (!isExist) {
        await redisConn.set(`ZOOMBIEE:${p.pid}`, true, "EX", 60 * 10)
        console.log(`start count down\n\nprocess: ${p.cmd}`)
      }
    }
  }
}

detectZoombieProcess()
