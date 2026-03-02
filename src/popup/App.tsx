/* hourglass:v0 — temporary sync config form in place of auth */

import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from "@/components/ui/form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Terminal } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";

const syncSchema = z.object({
    syncUrl: z.string().min(1, "Sync URL is required"),
    key: z.string().min(1, "Key is required"),
});

type SyncFormValues = z.infer<typeof syncSchema>;

const STORAGE_KEY = "syncConfig";

export default function App() {
    const form = useForm<SyncFormValues>({
        resolver: zodResolver(syncSchema),
        defaultValues: { syncUrl: "", key: "" },
    });

    // Load saved values from chrome.storage on mount
    useEffect(() => {
        chrome.storage.local.get(STORAGE_KEY, (result) => {
            const saved = result[STORAGE_KEY] as SyncFormValues | undefined;
            if (saved) form.reset(saved);
        });
    }, [form]);

    function onSubmit(values: SyncFormValues) {
        chrome.storage.local.set({ [STORAGE_KEY]: values });
    }

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
        <div className="w-72 bg-background p-3">
            <Form {...form}>
                <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="space-y-3"
                >
                    <FormField
                        control={form.control}
                        name="syncUrl"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Sync URL</FormLabel>
                                <FormControl>
                                    <Input
                                        placeholder="https://..."
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <FormField
                        control={form.control}
                        name="key"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel>Key</FormLabel>
                                <FormControl>
                                    <Input placeholder="your-key" {...field} />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                    <Button type="submit" className="w-full">
                        Save
                    </Button>
                </form>
            </Form>

            <Separator className="my-3" />

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
