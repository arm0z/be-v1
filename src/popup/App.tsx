import { Button } from "@/components/ui/button";
import { Terminal } from "lucide-react";

export default function App() {
    function openDevTools() {
        chrome.windows.create({
            url: chrome.runtime.getURL("src/dev/index.html"),
            type: "popup",
            width: 1200,
            height: 800,
        });
        window.close();
    }

    return (
        <div className="w-64 bg-background p-2">
            <Button
                variant="ghost"
                className="w-full justify-start gap-2"
                onClick={openDevTools}
            >
                <Terminal className="h-4 w-4" />
                Developer Tools
            </Button>
        </div>
    );
}
