import { CommandInteraction, Guild, SlashCommandBuilder, type APIGuildMember } from "discord.js";

export default {
    data: new SlashCommandBuilder().setName("ping").setDescription("Replies with Pong!"),
    async execute(interaction: CommandInteraction) {
        const member = interaction.member as APIGuildMember;
        console.log(member.joined_at);
		await interaction.reply(
			{
                content: `This command was run by ${interaction.user.username}, who joined on ${member.joined_at}.`,
                flags: 'Ephemeral',
            },
		);
    }
}