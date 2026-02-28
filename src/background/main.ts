chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'DOM_EVENT') {
    console.log(
      `[${message.event}]`,
      message.target,
      `tab:${sender.tab?.id}`,
      message.timestamp,
    )
  }
})
