import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Collection,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  InteractionResponse,
  Message,
  MessageFlags,
  StringSelectMenuInteraction,
  type CacheType,
} from "discord.js";
import type { FileNode } from "./file-node";
import { flatten, type MeiliFileDoc } from "./flatten";
import search from "./commands/utility/search";
import { MeiliSearch } from "meilisearch";
import pLimit from "p-limit";

console.log("Starting up...");

export type CurrentSearch = {
  query: string;
  selectReply: InteractionResponse;
  selectInteraction: StringSelectMenuInteraction<CacheType>;
  userId: string;
  replyInteraction?: Message<boolean>;
};

export const currentSearches: CurrentSearch[] = [];

export const fileList: MeiliFileDoc[] = [];

const BATCH_SIZE = 5000;

export const meiliClient = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST!,
  apiKey: process.env.MEILISEARCH_API_KEY!,
});

if (meiliClient.getVersion().catch(() => undefined) === undefined) {  
  console.error("Unable to connect to Meilisearch. Please ensure it is running and the MEILISEARCH_HOST and MEILISEARCH_API_KEY environment variables are correct.");
  process.exit(1);
}

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

    const limit = pLimit(process.env.FETCH_CONCURRENCY ? parseInt(process.env.FETCH_CONCURRENCY) : 10);

    const dirChildTasks = dirChilds.map((child) =>
      limit(() => fetchRecursive(child, `${nextPath}`)),
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
export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds],
});

discordClient.once(Events.ClientReady, (readyClient) => {
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

  const matches =
    (await index.search(parsed.query, {
      limit: 50,
    })) ?? [];

  if (
    !matches ||
    selectIndex < 0 ||
    selectIndex >= matches.hits.length ||
    !matches.hits[selectIndex]
  ) {
    await interaction.followUp({
      content: "Invalid selection.",
      components: [],
    });
    return;
  }

  const item = matches.hits.find((_, index) => index === selectIndex);

  if (!item) {
    await interaction.followUp({
      content: "Selected item not found.",
      components: [],
    });
    return;
  }

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

  const previousSearchInteractionIndex = currentSearches.findIndex(
    (s) => s.userId === interaction.user.id,
  );

  if (previousSearchInteractionIndex === -1) {
    console.warn(
      `No previous search interaction found for user ${interaction.user.id}`,
    );

    await interaction.followUp({
      content: `Previous search interaction not found.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const previousSearch = currentSearches[previousSearchInteractionIndex];

  if (previousSearch && !previousSearch.replyInteraction) {
    let followUp: Message<boolean>;
    if (item.ext === "jpg" || item.ext === "png" || item.ext === "gif") {
      followUp = await interaction.followUp({
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
      followUp = await interaction.followUp({
        content: `Selected **${decodeURIComponent(item.href)}**`,
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
    }
    previousSearch!.replyInteraction = followUp;
    previousSearch!.selectInteraction = interaction;
    return;
  }

  if (previousSearch && previousSearch.replyInteraction) {
    // Fetch the message to ensure channel is cached
    let selectFollowup = previousSearch.replyInteraction;
    const selectReply = previousSearch.selectInteraction;

    if (item.ext === "jpg" || item.ext === "png" || item.ext === "gif") {
      await selectReply.editReply({
        content: `Selected **${decodeURIComponent(item.href)}**\n${item.fullHref}`,
        components: [row],
        embeds: [
          {
            image: {
              url: item.fullHref,
            },
          },
        ],
        message: selectFollowup,
      });
    } else {
      await selectReply.editReply({
        content: `Selected **${decodeURIComponent(item.href)}**`,
        components: [row],
        message: selectFollowup,
      });
    }
  }
};

discordClient.on(Events.InteractionCreate, async (interaction) => {
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

(async () => {
  const rawInfo = await index.getRawInfo().catch(() => undefined);
  const stats = await index.getStats().catch(() => undefined);
  const exists =
    rawInfo?.createdAt !== undefined &&
    stats?.numberOfDocuments !== undefined &&
    stats.numberOfDocuments > 0 &&
    process.env.FORCE_REINDEX !== "true";
  if (!exists) {
    await index.deleteAllDocuments().catch(() => undefined);

    createFileTree()
      .then(async (files) => {
        const flattened = flatten(files);

        console.log(`Flattened file tree contains ${flattened.length} items.`);
        console.log("Adding documents to Meilisearch index...");

        for (let i = 0; i < flattened.length; i += BATCH_SIZE) {
          const batch = flattened.slice(i, i + BATCH_SIZE);

          console.log(
            `Uploading ${i} → ${i + batch.length} / ${flattened.length}`,
          );

          const task = await index.addDocuments(batch);
          await waitForTask(task.taskUid);
        }

        await index.updateSearchableAttributes([
          "lead",
          "href",
          "fullHref",
          "ext",
          "sz",
          "ts",
          "tags",
          "params",
          "type",
          "path",
        ]);

        console.log("Indexing complete.");
      })
      .catch((err) => {
        console.error("Error creating file tree:", err);
      });
  }

  discordClient.login(token);
})();
