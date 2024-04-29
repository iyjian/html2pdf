exports.getElementLeft = (element) => {
  let actualLeft = element.offsetLeft
  let current = element.offsetParent

　 while (current !== null) {
  　 actualLeft += current.offsetLeft
　　　current = current.offsetParent
　 }

　 return actualLeft
}

exports.getElementTop = (element) => {
  let actualTop = element.offsetTop
  let current = element.offsetParent
  
  while (current !== null) {
    actualTop += current.offsetTop
  　current = current.offsetParent
  }
  
  return actualTop
}

exports.sleep = ms => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      resolve(true)
    }, ms)
  })
}
  