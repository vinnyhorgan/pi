/**
 * Custom Header Extension
 *
 * Demonstrates ctx.ui.setHeader() for replacing the built-in header
 * (logo + keybinding hints) with a custom component showing the pi mascot.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { VERSION } from "@mariozechner/pi-coding-agent";

function getPiMascot(theme: Theme): string[] {
  const piBlue = (text: string) => theme.fg("accent", text);
  const white = (text: string) => text;
  const black = (text: string) => theme.fg("dim", text);

  const BLOCK = "█";
  const PUPIL = "▌";

  const eye = `${white(BLOCK)}${black(PUPIL)}`;
  const lineEyes = `     ${eye}  ${eye}`;
  const lineBar = `  ${piBlue(BLOCK.repeat(14))}`;
  const lineLeg = `     ${piBlue(BLOCK.repeat(2))}    ${piBlue(BLOCK.repeat(2))}`;

  return ["", lineEyes, lineBar, lineLeg, lineLeg, lineLeg, lineLeg, ""];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setHeader((_tui, theme) => {
        return {
          render(_width: number): string[] {
            const mascotLines = getPiMascot(theme);
            const subtitle = `${theme.fg("muted", "   shitty coding agent")}${theme.fg("dim", ` v${VERSION}`)}`;
            return [...mascotLines, subtitle];
          },
          invalidate() {},
        };
      });
    }
  });

  pi.registerCommand("builtin-header", {
    description: "Restore built-in header with keybinding hints",
    handler: async (_args, ctx) => {
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
