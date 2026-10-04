/**
 * Decoy words for the Vosk grammar. With only the trigger words in the grammar, Vosk has to map all
 * speech onto them (or [unk]), so ordinary talk keeps landing on the nearest trigger. Decoys give
 * that speech somewhere harmless to land: common words, plus words that sound like each trigger.
 * Every decoy is in the small English model's vocabulary (checked against its symbol table).
 */

/** Words that sound like a trigger's own words: decoying them would steal the trigger itself. */
const HOMOPHONES: Record<string, string[]> = {
  i: ['eye', 'aye'],
  you: ['u', 'ewe', 'yew'],
  bye: ['by', 'buy', 'bi'],
  no: ['know'],
  way: ['weigh', 'whey'],
  "let's": ['lets']
}

/** Near-sounding words per trigger word: where misheard speech should go instead. */
const NEAR: string[] = [
  // let's go
  'let', 'less', 'lens', 'low', 'goal', 'gold', 'though', 'although', 'ago', 'logo', 'glow', 'grow', 'get', 'guess',
  'yes', 'us', 'going', 'gone', 'got', 'good', 'ghost', 'most', 'close', 'goes',
  // (I) love you
  'loved', 'lovely', 'loving', 'lot', 'lose', 'move', 'of', 'above', 'glove', 'view', 'few', 'new', 'do', 'to', 'too',
  'who', 'yeah', 'your', "you're", 'use', 'a', 'my', 'hi', 'high', "i'm", "i'll", "i've", "i'd",
  // fire
  'five', 'find', 'fine', 'far', 'fair', 'fight', 'for', 'four', 'fly', 'higher', 'hire', 'tired', 'wire', 'liar',
  'father', 'file', 'fear', 'fur', 'fired', 'buyer',
  // boom
  'boo', 'room', 'zoom', 'doom', 'broom', 'bomb', 'boot', 'book', 'moon', 'blue', 'beam', 'bump', 'whom', 'bloom',
  // bye
  'bike', 'bite', 'bay', 'boy', 'pie', 'why', 'bright', 'behind', 'bad', 'bit',
  // no way
  'now', 'nope', 'not', 'nobody', 'away', 'wait', 'always', 'anyway', 'where', 'okay', 'today', 'say', 'day', 'they',
  'hey', 'play', 'stay', 'may', 'away'
]

/** Common conversational words. */
const COMMON: string[] = [
  'the', 'an', 'and', 'or', 'but', 'so', 'if', 'then', 'that', 'this', 'these', 'those', 'it', "it's", 'is', 'are',
  'was', 'were', 'be', 'been', 'have', 'has', 'had', 'does', 'did', "don't", 'can', "can't", 'could', 'would',
  'should', 'will', 'just', 'really', 'very', 'much', 'more', 'some', 'any', 'all', 'what', 'when', 'how', 'which',
  'there', 'here', 'with', 'from', 'about', 'into', 'over', 'after', 'before', 'because', 'think', 'want', 'need',
  'like', 'see', 'look', 'make', 'take', 'come', 'said', 'tell', 'talk', 'call', 'work', 'time', 'week', 'year',
  'people', 'thing', 'things', 'something', 'nothing', 'everything', 'right', 'um', 'uh', 'oh', 'well', 'maybe',
  'actually', 'sure', 'thanks', 'thank', 'please', 'sorry', 'meeting', 'project', 'team', 'email', 'tomorrow',
  'yesterday', 'morning', 'night', 'home', 'office', 'back', 'still', 'also', 'even', 'only', 'first', 'last', 'next',
  'other', 'same', 'different', 'little', 'big', 'long', 'great', 'nice', 'fun', 'hard', 'easy', 'start', 'stop',
  'keep', 'put', 'give', 'feel', 'try', 'mean', 'kind', 'sort', 'part', 'place', 'point', 'number', 'question',
  'problem', 'idea', 'plan', 'money', 'food', 'dinner', 'lunch', 'coffee', 'friend', 'family', 'brother', 'sister',
  'mother', 'kids', 'school', 'house', 'car', 'phone', 'computer', 'video', 'camera', 'screen', 'music', 'game',
  'show', 'picture', 'hello', 'we', 'he', 'she', 'them', 'our', 'their', 'me', 'him', 'her', 'his', 'its', 'one',
  'two', 'three', 'ten', 'hundred', 'minute', 'minutes', 'hour', 'hours', 'month', 'end', 'second', 'water', 'open',
  'name', 'life', 'world', 'story', 'person', 'everybody', 'someone', 'never', 'ever', 'again', 'around', 'under',
  'between', 'without', 'through', 'while', 'until', 'since', 'during', 'each', 'every', 'both', 'few', 'many', 'own',
  'old', 'young', 'small', 'large', 'high', 'early', 'late', 'real', 'best', 'bad', 'happy', 'ready', 'free'
]

export const DECOYS: readonly string[] = [...new Set([...NEAR, ...COMMON])]

/**
 * The decoys to use alongside these trigger words/phrases: every decoy except the triggers' own words
 * and their homophones (saying "bye" must not land on "by").
 */
export function decoysFor(triggers: readonly string[]): string[] {
  const banned = new Set<string>()
  for (const t of triggers) {
    for (const token of t.trim().toLowerCase().split(/\s+/)) {
      banned.add(token)
      for (const h of HOMOPHONES[token] ?? []) banned.add(h)
    }
  }
  return DECOYS.filter((d) => !banned.has(d))
}
