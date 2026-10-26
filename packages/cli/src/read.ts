/** `context`, `find` and `read`: the read commands. Port of cli.run_read. */

import {
  Access, bodyStart, bounded, type Config, contextPacket, find, headingRange, lineCount, type Packet, Rejected,
  sourceHit, withRepositoryLock,
} from "@rcllr/core";

import type { Namespace } from "./argparse.ts";
import { out } from "./io.ts";
import { checkRange, LIMIT_RANGE } from "./options.ts";

export function runRead(args: Namespace, config: Config, tone: string): number {
  withRepositoryLock(config.root, () => {
    const access = new Access(config, args.scope as string | null, args.topic as string | null,
                              args.allowSensitive as string[]);
    let packet: Packet;
    if (args.command === "context") {
      packet = contextPacket(access, args.query as string);
    } else if (args.command === "find") {
      const limit = args.limit === null ? config.limits.findLimit : args.limit as number;
      checkRange(limit, LIMIT_RANGE, "limit_range");
      packet = find(access, args.query as string, limit);
    } else {
      const startArg = args.start as number | null;
      const endArg = args.end as number | null;
      const section = args.section as string | null;
      if ((startArg !== null && startArg < 1) || (endArg !== null && endArg < (startArg || 1))) {
        throw new Rejected("bad_line_range");
      }
      if (section !== null && (startArg !== null || endArg !== null)) throw new Rejected("section_with_range");
      const note = access.read(args.path as string);
      let end = endArg !== null ? endArg : lineCount(note);
      let start = startArg;
      if (start === null) {
        const first = bodyStart(note);
        start = endArg === null || endArg >= first ? first : 1;
      }
      if (section !== null) [start, end] = headingRange(note.text, section);
      // The revision also at the top: a single read is usually followed by write --expected.
      packet = { revision: note.revision, hits: [sourceHit(note, start, end)], match: "direct", more: false,
        truncated: false };
    }
    out(bounded(packet, args.maxChars as number, args.json as boolean, tone,
                { notePartial: args.command !== "context" }));
  }, config.limits.lockTimeoutS);
  return 0;
}
