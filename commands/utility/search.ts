import { SlashCommandBuilder } from "discord.js";

export default {
    data: new SlashCommandBuilder().setName("search").setDescription("Search for a file in Copy Party.").addStringOption(option =>
        option.setName("query")
            .setDescription("The query to search for.").setAutocomplete(true)
            .setRequired(true)
    ),
    async execute(interaction: any) {
        const query = interaction.options.getString("query")!;
        await interaction.reply({
            content: `You searched for: ${query}`,
            flags: 'Ephemeral',
        });
    }
}