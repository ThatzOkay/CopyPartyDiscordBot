export type FileNode = {
    lead: string;
    href: string;
    ext: string;
    sz: number;
    ts: number;
    tags: string[];
    params: string;
    type: "file" | "dir";
    children?: FileNode[];
}
