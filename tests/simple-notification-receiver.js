import {App} from "uWebSockets.js";

const app = App();
app.post("/notification", (res, req) => {
    let data = "";
    res.onData((ab, isLast) => {
        let chunk = Buffer.from(ab);
        data += chunk.toString();
        if (isLast) {
            console.log(data);
            res.writeStatus("200 OK");
            res.end("Notification received");
        }
    });
    res.onAborted(() => {
        console.log("Request aborted");
    });
});
app.listen(6200, (token) => {
    if (token) {
        console.log("Listening to port 6200");
    } else {
        console.error("Failed to listen to port 6200");
    }
});
