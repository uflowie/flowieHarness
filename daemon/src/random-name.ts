// Random names for worktrees the user did not name: two short words, such as "brave-otter", easy to read and say.
import { randomInt } from "node:crypto";

const ADJECTIVES = [
	"amber", "bold", "brave", "bright", "calm", "clever", "cosmic", "crisp", "dapper", "eager", "fancy", "fuzzy",
	"gentle", "glad", "golden", "happy", "hidden", "jolly", "keen", "kind", "lively", "lucky", "mellow", "merry",
	"mighty", "misty", "nimble", "noble", "plucky", "proud", "quick", "quiet", "rapid", "rustic", "shiny", "silent",
	"silver", "sleek", "snowy", "sunny", "swift", "tidy", "vivid", "warm", "wild", "witty", "zesty", "zippy",
];

const NOUNS = [
	"badger", "beacon", "bison", "brook", "canyon", "cedar", "comet", "coral", "crane", "delta", "ember", "falcon",
	"fern", "fjord", "garnet", "gecko", "glacier", "harbor", "heron", "island", "jaguar", "kestrel", "lagoon", "lemur",
	"lynx", "maple", "meadow", "meteor", "moose", "nebula", "otter", "panda", "pebble", "pine", "quartz", "raven",
	"reef", "river", "robin", "sparrow", "summit", "tiger", "tundra", "valley", "walrus", "willow", "yak", "zebra",
];

/** A random `adjective-noun` name. */
export function randomName(): string {
	return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}
