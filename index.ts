import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Collection,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  MessageFlags,
  messageLink,
  StringSelectMenuInteraction,
  type CacheType,
} from "discord.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import type { FileNode } from "./file-node";
import { flatten, type MeiliFileDoc } from "./flatten";
import Fuse from "fuse.js";
import search from "./commands/utility/search";
import { MeiliSearch } from "meilisearch";

export const fileList: MeiliFileDoc[] = [];

const BATCH_SIZE = 5000;

export const meiliClient = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST!,
  apiKey: process.env.MEILISEARCH_API_KEY!,
});

export const index = meiliClient.index("files");

async function waitForTask(taskUid: number) {
  let task;
  do {
    task = await meiliClient.tasks.getTask(taskUid);
    if (task.status === "succeeded") return;
    if (task.status === "failed") throw new Error(JSON.stringify(task));
    await new Promise((r) => setTimeout(r, 100)); // 100ms delay
  } while (true);
}

const createFileTree = async () => {
  const files: FileNode[] = [];

  const root = await fetch(`${process.env.COPY_PARTY_URL}/?ls&dots`, {
    method: "GET",
    headers: {
      PW: `${process.env.COPY_PARTY_PASSWORD}`,
    },
  });

  const json = (await root.json()) as { dirs: FileNode[]; files: FileNode[] };

  console.log(json);

  const dirs = json.dirs;
  dirs.forEach((dir) => {
    dir.type = "dir";
  });

  const fileNodes = json.files;
  fileNodes.forEach((file) => {
    file.type = "file";
  });

  files.push(...dirs);
  files.push(...fileNodes);

  for (const dir of json.dirs) {
    await fetchRecursive(dir, "/");
  }

  console.log("Completed fetching file tree.");

  return files;
};

const fetchRecursive = async (
  node: FileNode,
  previousPath: string,
): Promise<void> => {
  const nextPath = previousPath + node.href;
  console.log(`Fetching: ${nextPath}`);
  const res = await fetch(`${process.env.COPY_PARTY_URL}${nextPath}?ls&dots`, {
    method: "GET",
    headers: {
      PW: `${process.env.COPY_PARTY_PASSWORD}`,
    },
  });

  if (!res.ok) {
    console.error(
      `Failed to fetch ${nextPath}: ${res.status} ${res.statusText} retrying`,
    );
    await fetchRecursive(node, previousPath);
  }

  try {
    const json = (await res.json()) as { dirs: FileNode[]; files: FileNode[] };
    const children: FileNode[] = [];

    json.dirs.forEach((dir) => {
      dir.type = "dir";
      children.push(dir);
    });

    json.files.forEach((file) => {
      file.type = "file";
      children.push(file);
    });

    node.children = children;

    const dirChilds = children.filter((child) => child.type === "dir");
    const dirChildTasks = dirChilds.map((child) =>
      fetchRecursive(child, `${nextPath}`),
    );
    await Promise.all(dirChildTasks);
  } catch (err) {
    console.error(`Error parsing JSON for ${nextPath}:`, err);
    await fetchRecursive(node, previousPath);
  }
};

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error("DISCORD_TOKEN is not defined in environment variables.");
}
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready! Logged in as ${readyClient.user.tag}`);
});

const commands = new Collection();
commands.set("search", search);

const handleSelectInteraction = async (
  interaction: StringSelectMenuInteraction<CacheType>,
) => {
  await interaction.deferUpdate();
  const parsed = JSON.parse(interaction.values[0]!);
  const selectIndex = Number(parsed.i);

  const matches = await index.search(parsed.query) ?? [];

  if (!matches || selectIndex < 0 || selectIndex >= matches.hits.length || !matches.hits[selectIndex]) {
    await interaction.update({
      content: "Invalid selection.",
      components: [],
    });
    return;
  }

  const item = matches.hits.find((_, index) => index === selectIndex)?.item;

  const openUrl = item.fullHref;
  const downloadUrl = item.type === "dir" ? item.lead : item.fullHref + "?dl";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Open")
      .setStyle(ButtonStyle.Link)
      .setURL(openUrl),

    new ButtonBuilder()
      .setLabel("Download")
      .setStyle(ButtonStyle.Link)
      .setURL(downloadUrl),
  );

  if (item.ext === "jpg" || item.ext === "png" || item.ext === "gif") {
    await interaction.followUp({
      content: `Selected **${decodeURIComponent(item.href)}**\n${item.fullHref}`,
      components: [row],
      embeds: [
        {
          image: {
            url: item.fullHref,
          },
        },
      ],
      flags: MessageFlags.Ephemeral,
    });
  } else {
    await interaction.followUp({
      content: `Selected **${decodeURIComponent(item.href)}**`,
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  }
};

client.on(Events.InteractionCreate, async (interaction) => {
  if (
    interaction.isStringSelectMenu() &&
    interaction.customId === "search_select"
  ) {
    await handleSelectInteraction(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName) as
    | { execute: (interaction: CommandInteraction) => Promise<void> }
    | undefined;

  if (!command) {
    console.error(`No command matching ${interaction.commandName} was found.`);
    return;
  }
  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "There was an error while executing this command!",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "There was an error while executing this command!",
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

const rawInfo = await index.getRawInfo().catch(() => undefined);
const stats = await index.getStats().catch(() => undefined);
const exists = rawInfo?.createdAt !== undefined 
               && stats?.numberOfDocuments !== undefined 
               && stats.numberOfDocuments > 0 
               && process.env.FORCE_REINDEX !== "true";
if (!exists) {
createFileTree()
  .then(async (files) => {

      const flattened = flatten(files);

      console.log(
        `Flattened file tree contains ${flattened.length} items.`
      );
      console.log("Adding documents to Meilisearch index...");

      for (let i = 0; i < flattened.length; i += BATCH_SIZE) {
        const batch = flattened.slice(i, i + BATCH_SIZE);

        console.log(
          `Uploading ${i} → ${i + batch.length} / ${flattened.length}`
        );

        const task = await index.addDocuments(batch);
        await waitForTask(task.taskUid);
      }

      console.log("Indexing complete.");
  })
  .catch((err) => {
    console.error("Error creating file tree:", err);
  });
}

client.login(token);
