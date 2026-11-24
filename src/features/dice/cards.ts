import { container as sapphire } from '@sapphire/framework';
import {
  ActionRowBuilder,
  type APIContainerComponent,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
} from 'discord.js';
import { spinErrorText } from '../gamba/index.js';
import { accents, coins, withFiles } from '../ui/index.js';
import { allCalls, callLabel, type DiceCall, dieFace, encodeCall } from './calls.js';
import { wager } from './config.js';
import { encodeCallSelectId, encodeDoubleId, encodeRollAgainId } from './custom-ids.js';
import type { Roll } from './play.js';
import { type DiceTint, type DieFace, renderDice } from './render.js';
import { multiplierText, needsText, oddsText, winningCalls } from './rules.js';

export const notYourRoll = "This isn't your roll. Use `/dice` to roll your own.";

/** Dice bets fail like gamba spins do, so the messages stay identical. */
export const diceErrorText = spinErrorText;

/** A rendered dice picture to show on a card. */
export interface DiceImage {
  name: string;
  png: Buffer;
  alt: string;
}

/** The attachment name of a result card's picture. */
export const resultImageName = 'dice-result.png';

/** The bet after Double: twice the bet, clamped to the maximum. */
export const doubledBet = (bet: number) => Math.min(bet * 2, wager.maxBet);

/** A Components V2 card: the picture (if any) on top, then the texts, then the controls. */
function diceCard(
  accent: number,
  image: DiceImage | undefined,
  texts: string[],
  next?: { userId: string; bet: number; call: DiceCall; doubleDisabled: boolean },
): ContainerBuilder {
  const card = new ContainerBuilder().setAccentColor(accent);
  if (image) {
    card.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${image.name}`)
          .setDescription(image.alt),
      ),
    );
  }
  card.addTextDisplayComponents(...texts.map((text) => new TextDisplayBuilder().setContent(text)));
  if (next) addControls(card, next.userId, next.bet, next.call, next.doubleDisabled);
  return image ? withFiles(card, new AttachmentBuilder(image.png, { name: image.name })) : card;
}

const nextText = (bet: number, call: DiceCall) => `Next: **${callLabel(call)}** · ${coins(bet)}`;

/** The Change call menu and the Roll again and Double buttons, all for the next roll. */
function addControls(
  card: ContainerBuilder,
  userId: string,
  bet: number,
  call: DiceCall,
  doubleDisabled: boolean,
) {
  const doubled = doubledBet(bet);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(encodeCallSelectId({ userId, bet, call }))
    .setPlaceholder(`Change call (now ${callLabel(call)})`)
    .addOptions(
      allCalls.map((option) => ({
        label: callLabel(option),
        value: encodeCall(option),
        description: oddsText(option),
      })),
    );
  const buttons = [
    new ButtonBuilder()
      .setLabel('Roll again')
      .setCustomId(encodeRollAgainId({ userId, bet, call }))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setLabel(`Double · ${coins(doubled)}`)
      .setCustomId(encodeDoubleId({ userId, bet: doubled, call }))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(doubleDisabled),
  ];
  return card
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
}

/**
 * The settled roll. With an image the dice are drawn above the text, otherwise the heading shows
 * glyph dice. The odds and the hint are about the call that was made; `Next:` is what the
 * controls will roll, which the Change call menu edits in place.
 */
export function rollCard(userId: string, roll: Roll, image?: DiceImage): ContainerBuilder {
  const { bet, call, die1, die2, total, won, payout } = roll;
  const label = callLabel(call).toUpperCase();
  const heading = image
    ? `# ${total} · ${label} ${won ? '✓' : '✗'}`
    : `# 🎲 ${dieFace(die1)} ${dieFace(die2)} = ${total} · ${label} ${won ? '✓' : '✗'}`;
  const result = won
    ? `Won +${coins(payout - bet)} (${multiplierText(call)})`
    : `Lost ${coins(bet)}`;
  const odds = [oddsText(call)];
  if (!won) {
    const calls = winningCalls(die1, die2).map(callLabel);
    odds.push(`-# Would have won: ${calls.join(', ')}`);
  }
  const doubleDisabled = bet >= wager.maxBet || doubledBet(bet) > roll.balance;
  return diceCard(
    won ? accents.win : accents.loss,
    image,
    [
      heading,
      result,
      odds.join('\n'),
      nextText(bet, call),
      `-# <@${userId}> · balance ${coins(roll.balance)} · pot ${coins(roll.pot)}`,
    ],
    { userId, bet, call, doubleDisabled },
  );
}

/** The result card with its dice drawn; if drawing fails the glyph card is shown instead. */
export async function rollResult(userId: string, roll: Roll): Promise<ContainerBuilder> {
  try {
    const tint: DiceTint = roll.won ? 'win' : 'loss';
    const png = await renderDice(roll.die1 as DieFace, roll.die2 as DieFace, tint);
    return rollCard(userId, roll, {
      name: resultImageName,
      png,
      alt: `Dice showing ${roll.die1} and ${roll.die2}`,
    });
  } catch (error) {
    sapphire.logger?.warn(`dice: could not draw the dice, using glyphs: ${String(error)}`);
    return rollCard(userId, roll);
  }
}

/**
 * The same card with a different call for the next roll: the roll shown stays as it is, only the
 * `Next:` line and the controls (whose IDs carry the call) change.
 */
export function retargetCard(
  card: APIContainerComponent,
  userId: string,
  bet: number,
  call: DiceCall,
): ContainerBuilder {
  const doubleDisabled = JSON.stringify(card).includes('"disabled":true');
  const kept = card.components
    .filter((component) => component.type !== ComponentType.ActionRow)
    .map((component) => {
      if (component.type === ComponentType.TextDisplay && component.content.startsWith('Next:')) {
        return { ...component, content: nextText(bet, call) };
      }
      if (component.type === ComponentType.MediaGallery) {
        // The picture is already on the message; refer to it by name instead of its CDN link.
        return {
          ...component,
          items: component.items.map((item) =>
            item.media.url.includes(`/${resultImageName}`)
              ? { description: item.description, media: { url: `attachment://${resultImageName}` } }
              : item,
          ),
        };
      }
      return component;
    });
  const next = new ContainerBuilder({ ...card, components: kept });
  return addControls(next, userId, bet, call, doubleDisabled);
}

const randomFace = () => (1 + Math.floor(Math.random() * 6)) as DieFace;

/**
 * The cosmetic build-up to a settled roll: two tumbling dice, the first one landing next to a
 * `?` die, then what it leaves the player needing. The second die and the outcome are never
 * shown or drawn, so frames cannot contradict the result card. If drawing fails the frames fall
 * back to glyphs.
 */
export async function rollFrames(
  userId: string,
  roll: Pick<Roll, 'bet' | 'call' | 'die1'>,
): Promise<ContainerBuilder[]> {
  const caption = `<@${userId}> called **${callLabel(roll.call)}** · ${coins(roll.bet)}`;
  const first = dieFace(roll.die1);
  const faces = (): [DieFace, DieFace] => [randomFace(), randomFace()];
  const [t1, t2] = [faces(), faces()];
  const pictures = await Promise.all([
    renderDice(t1[0], t1[1], 'rolling'),
    renderDice(t2[0], t2[1], 'rolling'),
    renderDice(roll.die1 as DieFace, 'unknown', 'rolling'),
  ]).catch((error: unknown) => {
    sapphire.logger?.warn(`dice: could not draw the frames, using glyphs: ${String(error)}`);
    return undefined;
  });
  const frame = (
    accent: number,
    glyphs: string,
    heading: string,
    footer: string,
    index: number,
    alt: string,
  ) => {
    const png = pictures?.[index];
    return png
      ? diceCard(accent, { name: `dice-${index}.png`, png, alt }, [heading, caption, footer])
      : diceCard(accent, undefined, [glyphs, caption, footer]);
  };
  const tumbling = (index: 0 | 1) => {
    const [left, right] = index === 0 ? t1 : t2;
    return frame(
      accents.brand,
      `# 🎲 ${dieFace(left as number)} ${dieFace(right as number)}`,
      '# Rolling…',
      '-# tumbling',
      index,
      'Two tumbling dice',
    );
  };
  const landed = (accent: number, footer: string) =>
    frame(
      accent,
      `# 🎲 ${first} 🎲`,
      `# First die: ${roll.die1}`,
      footer,
      2,
      `A die showing ${roll.die1} and a hidden die`,
    );
  return [
    tumbling(0),
    tumbling(1),
    landed(accents.brand, '-# first die down'),
    landed(accents.gold, `-# ${needsText(roll.call, roll.die1)}`),
  ];
}
