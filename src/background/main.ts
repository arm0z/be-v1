chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === "capture") {
        console.log(
            `[${message.event}]`,
            message.target,
            `tab:${sender.tab?.id}`,
            message.timestamp,
        );
    }
});
