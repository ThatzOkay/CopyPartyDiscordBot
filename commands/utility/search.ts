import {
  ActionRowBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { fuse } from "../..";

export default {
  data: new SlashCommandBuilder()
    .setName("search")
    .setDescription("Search for a file or directory in Copy Party.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("The query to search for.")
        .setAutocomplete(true)
        .setRequired(true),
    ),
  async execute(interaction: any) {
    const query = interaction.options.getString("query")!;

    const matches = fuse?.search(query) ?? [];

    if (matches.length === 0) {
      await interaction.reply({
        content: `No results found for: ${query}`,
        flags: "Ephemeral",
      });
      return;
    }

    const results = matches.slice(0, 25);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("search_select")
      .setPlaceholder("Select a result")
      .addOptions(
        results.map((m, i) => ({
          label: decodeURIComponent(m.item.href).slice(0, 100),
          value: JSON.stringify({ i, query }),
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );

    await interaction.reply({
      content: `Found ${matches.length} results. Showing top ${results.length}.`,
      components: [row],
      flags: "Ephemeral",
    });
  },
};
