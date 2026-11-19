// Wordings about other players' permanents and permanents leaving for the graveyard, found on
// one-off cards in real decks (Elesh Norn, Authority of the Consuls, Disciple of the Vault).
// classifyRare.ts calls boardTrigger first in rareTrigger, and recogniseBoard first in recogniseRare.

import type { CastFilter, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number };
type BoardContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string };

/** Trigger wordings: an opponent's creature entering, an artifact or enchantment going to a graveyard. */
export function boardTrigger(l: string): BoardContext | null {
  let m: RegExpMatchArray | null;
  // Authority of the Consuls, Suture Priest: "whenever a creature an opponent controls enters".
  if ((m = l.match(/^whenever a creature an opponent controls enters(?: the battlefield)?,\s*(.*)$/))) return { when: 'opponentCreatureEnters', body: m[1] };
  // Disciple of the Vault (anyone's artifact), Ashiok's Reaper (your enchantment): rule 700.4 "put into a graveyard from the battlefield".
  if ((m = l.match(/^whenever an? (artifact|enchantment)( you control)? is put into a graveyard from the battlefield,\s*(.*)$/))) {
    const body = m[3].replace(/^you may have target opponent lose/, 'target opponent loses');
    return { when: 'permDies', castFilter: m[1] as CastFilter, scope: m[2] ? 'any' : 'all', body };
  }
  return null;
}

/** Static wordings about opponents' creatures. */
export function recogniseBoard(line: string, out: Found[]): boolean {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^creatures your opponents control get -(\d+)\/-(\d+)\.?$/))) {
    out.push({ body: { kind: 'oppAnthem', p: -parseInt(m[1], 10), t: -parseInt(m[2], 10) }, note: `Opponents' creatures get -${m[1]}/-${m[2]}` });
    return true;
  }
  if ((m = line.match(/^(artifacts and )?creatures your opponents control enter tapped\.?$/))) {
    out.push({ body: { kind: 'oppEnterTapped', ...(m[1] ? { artifacts: true } : {}) }, note: `Opponents' ${m[1] ? 'artifacts and creatures' : 'creatures'} enter tapped` });
    return true;
  }
  return false;
}
