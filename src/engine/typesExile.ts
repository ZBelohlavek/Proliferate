// Effects for playing cards from exile and from the top of a library, casting
// spells without paying their mana cost, rearranging the top of a library, and
// rules about searching libraries. Kept apart from types.ts so the rest of the
// model stays easy to follow; EffectBody includes ExileEffect.

/** Which cards an effect cares about. */
export type CardKind =
  | 'any'
  | 'nonland'
  | 'land'
  | 'permanent'
  | 'nonlandPermanent'
  | 'creature'
  | 'instantSorcery'
  | 'instant'
  | 'artifact'
  | 'enchantment'
  | 'artifactOrColorless'
  | 'colorlessNonland'
  | 'legendaryCreature'
  | 'creatureInstantSorcery'
  | 'basicLand'
  /** Matches nothing: the cards are exiled with no permission (Mystic Forge's dig). */
  | 'none';

/**
 * Whose library, hand or graveyard: 'targetController' is the player the ability is about (a combat damage trigger's
 * player, or whoever controls what an earlier part hit); 'active' is the player whose turn it is (Blightwing Bandit).
 */
export type Who = 'you' | 'opponents' | 'each' | 'target' | 'targetController' | 'active';

/** How long cards exiled by an effect stay playable (rule 611.2). */
export type PlayWindow = 'turn' | 'nextTurn' | 'exiled';

export type ExileEffect =
  /**
   * Exile cards from a library; the controller may play them for a while (impulse draw, theft).
   * n: cards exiled from each library (-1 = X). from: whose library ('target' / 'targetController' is the player the
   * ability is aimed at or hit). bottom: from the bottom. look: look at this many first, exile `n` of them and put the
   * rest on the bottom. only: which of them may be played (the rest stay exiled). oneOf: only one of them may be played.
   * anyMana: mana of any type can be spent. payLife: pay life equal to its mana value instead of its mana cost.
   * free: without paying its mana cost. castOnly: spells only, not lands. ownTurn: only during your turn.
   */
  | {
      kind: 'exilePlay'; n: number; from: Who; until: PlayWindow;
      bottom?: boolean; look?: number; only?: CardKind; oneOf?: boolean; anyMana?: boolean; payLife?: boolean; free?: boolean; castOnly?: boolean;
      ownTurn?: boolean; /** Exile cards until one of this kind is exiled; only that one may be played. */ untilKind?: CardKind;
      /** Played while the source stays on the battlefield (Nightveil Specter, Intellect Devourer). */ whileSource?: boolean;
      /** Exile from a hand (Intellect Devourer) or a graveyard (Savvy Trader) instead of a library. */ zone?: 'hand' | 'graveyard';
      /** Cards still exiled go back to their owners' hands when the source leaves (Intellect Devourer). */ returnToHand?: boolean;
      /** At the next end step, cards still exiled go to their owners' graveyards (Mnemonic Betrayal). */ endReturn?: 'graveyard';
    }
  /**
   * Cast spells without paying their mana costs as this resolves (rule 608.2g).
   * from: where the cards come from. 'top' looks at the top `n` cards of a library ('library' whose: see `who`);
   * 'until' reveals cards until one of kind `only` (and mana value up to `maxCmc`); 'hand', 'graveyard': a hand or graveyard
   * ('who' says whose). casts: how many may be cast (99: any number). only: which spells. maxCmc: mana value at most this
   * (-1 = X, -2 = less than the spell that set it off, -3 = at most that spell's mana value; n -2 is that mana value too). rest: where the others go. copy: cast a copy, the card stays
   * (Mizzix's Mastery, Isochron Scepter). copies: how many copies. anyMana: pay the mana cost, with mana of any type,
   * instead of casting it free (Tinybones). exileAfter: an instant or sorcery cast this way is exiled afterwards.
   */
  | {
      kind: 'freeCast'; from: 'top' | 'until' | 'hand' | 'graveyard' | 'search' | /** The cards just milled (Jace's Mindseeker). */ 'milled';
      /** An opponent chooses one of the cards first; it can't be cast (Plargg and Nassari). */ oppExcludes?: boolean; n: number; casts: number; who: Who;
      /** A graveyard card chosen at random from each player (Kefka). */ random?: boolean;
      only?: CardKind; maxCmc?: number; rest?: 'bottom' | 'graveyard' | 'hand' | 'shuffle' | 'exile' | 'top';
      copy?: boolean; copies?: number; pay?: boolean; anyMana?: boolean; exileAfter?: boolean;
      /** If it isn't cast, put it into your hand instead (Rashmi, discover). */ elseHand?: boolean;
      /** Discover N (rule 701.57): exile until a nonland card with mana value N or less; cast it free or put it into your hand. */ discover?: boolean;
    }
  /**
   * Static: you may play cards from the top of your library (Future Sight, Bolas's Citadel, Mystic Forge).
   * what: which cards. subtypes: only spells with one of these creature types (Nalia). payLife: pay life equal to
   * their mana value instead (Bolas's Citadel). minCreatures: only while you control this many creatures with
   * different powers (coven, Augur of Autumn).
   */
  | { kind: 'playTop'; what: CardKind; subtypes?: string[]; payLife?: boolean; coven?: boolean }
  /** Static: once during each of your turns, cast a spell from your hand or the top of your library free (One with the Multiverse). */
  | { kind: 'freeEachTurn' }
  /** Look at the top n cards of your library and put them back in any order; `shuffle`: you may shuffle instead (Ponder). */
  | { kind: 'rearrange'; n: number; shuffle?: boolean }
  /**
   * Static rules about searching libraries. 'top4': opponents search only the top four cards (Aven Mindcensor).
   * 'noSearch': opponents' spells and abilities can't make them search (Ashiok, Dream Render). 'pay2': nobody can search
   * unless they pay {2} (Leonin Arbiter). 'agent': cards opponents find are exiled, and you may play them with mana of any
   * type (Opposition Agent).
   */
  | { kind: 'searchRule'; rule: 'top4' | 'noSearch' | 'pay2' | 'agent' }
  /**
   * Search your library for cards beyond a plain tutor. what: which cards. maxCmc: mana value at most this (-1 = X,
   * -3 = one more than the sacrificed artifact). to: where they go ('cast': cast it free now, 'top': on top of the library
   * after shuffling). n: how many (99: any number). totalCmc: their total mana value at most this (Protean Hulk).
   * who: 'target': the targeted player searches their own library (Varragoth). tapped: enters tapped.
   */
  | { kind: 'search'; what: CardKind; to: 'hand' | 'battlefield' | 'top' | 'cast' | 'exilePlay'; n: number; maxCmc?: number; totalCmc?: number; who?: 'target'; tapped?: boolean; colors?: string[] };
