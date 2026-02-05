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
  StringSelectMenuInteraction,
  type CacheType,
} from "discord.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import type { FileNode } from "./file-node";
import { flatten, type FuseItem } from "./flatten";
import Fuse from "fuse.js";

export const fileList: FuseItem[] = [];
export let fuse: Fuse<FuseItem> | null = null;

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

const folderPath = path.join(__dirname, "commands");
const commandFolders = await readdir(folderPath);

for (const folder of commandFolders) {
  const commandsPath = path.join(folderPath, folder);
  const commandFiles = (await readdir(commandsPath)).filter(
    (file) => file.endsWith(".ts") || file.endsWith(".js"),
  );
  for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = (await import(filePath)).default;

    if ("data" in command && "execute" in command) {
      commands.set(command.data.name, command);
    } else {
      console.log(
        `[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`,
      );
    }
  }
}

const handleSelectInteraction = async (
  interaction: StringSelectMenuInteraction<CacheType>,
) => {
  await interaction.deferUpdate();
  const parsed = JSON.parse(interaction.values[0]!);
  const index = Number(parsed.i);

  const matches = fuse?.search(parsed.query);

  if (!matches || index < 0 || index >= matches.length || !matches[index]) {
    await interaction.update({
      content: "Invalid selection.",
      components: [],
    });
    return;
  }

  const item = matches[index].item;

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

const loadFilesArray = () => {
  const jsonData = fs.readFileSync("file-tree.json", "utf-8");

    const parsedData: FuseItem[] = JSON.parse(jsonData);
    for (let i = 0; i < parsedData.length; i += 10_000) {
      fileList.push(...parsedData.slice(i, i + 10_000));
    }
    fuse = new Fuse(fileList, {
      keys: ["lead", "tags", "href", "fullHref"],
      threshold: 0.3,
    });
    console.log(`File tree created with ${fileList.length} items.`);
}

const exists = fs.existsSync("file-tree.json");
if (exists) {
  loadFilesArray();
} else {
createFileTree()
  .then((files) => {
    const flattened = flatten(files);

    fs.writeFileSync("file-tree.json", JSON.stringify(flattened));

    loadFilesArray();
    //Example working search:
    // const testPattern = "Rosellia";
    // const results = fuse.search(testPattern);
    // console.log(`Search results for "${testPattern}":`, results.slice(0, 5));
  })
  .catch((err) => {
    console.error("Error creating file tree:", err);
  });
}

client.login(token);
