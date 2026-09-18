/**
 * Offscreen document: MV3 service workers cannot fetch `file://` URLs, but an
 * extension page can (when "Allow access to file URLs" is enabled). The
 * background script forwards local reads here.
 */
chrome.runtime.onMessage.addListener(({ action, data }, _sender, callback) => {
  if (action !== 'offscreen:fetch') return
  fetch(data.url)
    // file:// responses report status 0, so only a rejected fetch is an error
    .then(res => res.text())
    .then(text => callback({ text }))
    .catch(err => callback({ error: String(err?.message || err) }))
  return true
})
export {}
