import {
  ActionRowBuilder,
  InteractionResponse,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from "discord.js";
import { currentSearches, discordClient, index } from "../..";

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
    const previousSearchInteraction = currentSearches.findIndex(
      (s) => s.userId === interaction.user.id,
    );

    if (previousSearchInteraction !== -1) {
      const previousSearch = currentSearches[previousSearchInteraction];

      if (previousSearch?.selectReply) {
        previousSearch.selectReply.delete().catch(() => {});
      }

      currentSearches.splice(previousSearchInteraction, 1);
    }

    const query = interaction.options.getString("query")!;

    const matches =
      (await index.search(query, {
        limit: 50,
      })) ?? [];

    if (matches.hits.length === 0) {
      await interaction.reply({
        content: `No results found for: ${query}`,
        flags: "Ephemeral",
      });
      return;
    }

    const results = matches.hits.slice(0, 25);

    const menu = new StringSelectMenuBuilder()
      .setCustomId("search_select")
      .setPlaceholder("Select a result")
      .addOptions(
        results.map((m, i) => ({
          label: decodeURIComponent(m.href).slice(0, 100),
          value: JSON.stringify({ i, query }),
        })),
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      menu,
    );

    const reply = (await interaction.reply({
      content: `Found ${matches.hits.length} results. Showing top ${results.length}.`,
      components: [row],
      flags: "Ephemeral",
    })) as InteractionResponse;

    const userId = interaction.user.id;

    currentSearches.push({
      query,
      selectReply: reply,
      userId,
      selectInteraction: interaction,
    });
  },
};
