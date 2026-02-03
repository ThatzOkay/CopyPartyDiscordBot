import {
  Client,
  Collection,
  CommandInteraction,
  Events,
  GatewayIntentBits,
  MessageFlags,
} from "discord.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import type { FileNode } from "./file-node";

const createFileTree = async () => {

    const files: FileNode[] = [];

    const root = await fetch(`${process.env.COPY_PARTY_URL}/?ls&dots`, {
        method: 'GET',
        headers: {
            'PW': `${process.env.COPY_PARTY_PASSWORD}`,
        },
    });

    const json = ( await root.json() ) as { dirs: FileNode[] };
    
    const dirs = json.dirs;
    dirs.forEach(dir => {
        dir.type = "dir";
    });

    files.push(...dirs);

    for (const dir of json.dirs) {
        await fetchRecursive(dir, "");
    }

    return files;
}

const fetchRecursive = async (node: FileNode, previousPath: string): Promise<void> => {
    const nextPath = previousPath + node.href;
    console.log(`Fetching: ${nextPath}`);
    const res = await fetch(`${process.env.COPY_PARTY_URL}${nextPath}?ls&dots`, {
        method: 'GET',
        headers: {
            'PW': `${process.env.COPY_PARTY_PASSWORD}`,
        },
    });
    
    const json = ( await res.json() ) as { dirs: FileNode[], files: FileNode[] };
    const children: FileNode[] = [];

    json.dirs.forEach(dir => {
        dir.type = "dir";
        children.push(dir);
    });

    json.files.forEach(file => {
        file.type = "file";
        children.push(file);
    });

    node.children = children;

    for (const child of children) {
        if (child.type === "dir") {
            await fetchRecursive(child, `${nextPath}` );
        }
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

client.on(Events.InteractionCreate, async (interaction) => {
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

createFileTree().then((files) => {
    fs.writeFileSync('file-tree.json', JSON.stringify(files));
}).catch((err) => {
  console.error("Error creating file tree:", err);
});

client.login(token);