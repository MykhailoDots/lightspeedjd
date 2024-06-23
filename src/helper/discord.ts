import { appEnvironment } from "../config";
import dayjs from "./customDayJs";
import logger from "./logger";

export interface SendMessageOptions {
  message: string;
  topSeparator?: boolean;
  bottomSeparator?: boolean;
  includeTimestamp?: boolean;
  includeClientName?: boolean;
}

export async function sendMessageToDiscord(
  options: SendMessageOptions
): Promise<void> {
  const {
    message,
    topSeparator = false,
    bottomSeparator = false,
    includeTimestamp = true,
    includeClientName = true,
  } = options;

  if (!appEnvironment.discord.webhookUrl) {
    logger.error(
      "Webhook URL is not defined. Please set the webhookUrl variable."
    );
    return;
  }

  let formattedMessage = message;

  // Include a timestamp if required
  if (includeTimestamp) {
    const timestamp = `${dayjs()
      .tz("Europe/Zurich")
      .format("DD.MM.YY HH:mm:ss")}`; // Adjust locale and options as necessary
    formattedMessage = `[${timestamp}] ${formattedMessage}`;
  }

  if (includeClientName) {
    const clientName = `${appEnvironment.client.name} (${appEnvironment.client.id})`;
    formattedMessage = `${formattedMessage} - ${clientName}`;
  }

  // Add separators if required
  if (topSeparator) {
    const separatorTop =
      "`---------------------------------------------------------------------------`\n";
    formattedMessage = `${separatorTop}${formattedMessage}`;
  }
  if (bottomSeparator) {
    const separatorBottom =
      "\n`---------------------------------------------------------------------------`";
    formattedMessage = `${formattedMessage}${separatorBottom}`;
  }

  try {
    const response = await fetch(appEnvironment.discord.webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: formattedMessage,
      }),
    });

    if (!response.ok) {
      logger.error(
        `Failed to send message to Discord: ${await response.text()}`
      );
    } else {
      logger.info("Message sent to Discord successfully!");
    }
  } catch (error) {
    logger.error(`Failed to send message to Discord: ${JSON.stringify(error)}`);
  }
}
