/**
 * Offline venue → tier lookup for the library table/cards.
 *
 * This is intentionally a pure front-end dictionary: no network request, no
 * metadata rewrite. It only labels a venue the paper already has, so an offline
 * library still lets a reader spot CCF-A / top-journal papers at a glance.
 */
export type VenueTier = { label: string; name: string; tone: "ccf-a" | "ccf-b" | "top-journal" };

type Entry = { label: string; name: string; patterns: RegExp[] };

const CCF_A: Entry[] = [
  { label: "CCF-A", name: "NeurIPS", patterns: [/\bneurips\b/i, /\bnips\b/i, /neural information processing systems/i] },
  { label: "CCF-A", name: "ICML", patterns: [/\bicml\b/i, /international conference on machine learning/i] },
  { label: "CCF-A", name: "AAAI", patterns: [/\baaai\b/i, /aaai conference on artificial intelligence/i] },
  { label: "CCF-A", name: "IJCAI", patterns: [/\bijcai\b/i, /international joint conference on artificial intelligence/i] },
  { label: "CCF-A", name: "ACL", patterns: [/\bacl\b/i, /annual meeting of the association for computational linguistics/i] },
  { label: "CCF-A", name: "CVPR", patterns: [/\bcvpr\b/i, /computer vision and pattern recognition/i] },
  { label: "CCF-A", name: "ICCV", patterns: [/\biccv\b/i, /international conference on computer vision/i] },
  { label: "CCF-A", name: "SIGMOD", patterns: [/\bsigmod\b/i, /acm sigmod/i] },
  { label: "CCF-A", name: "VLDB", patterns: [/\bvldb\b/i, /very large data bases/i] },
  { label: "CCF-A", name: "OSDI", patterns: [/\bosdi\b/i, /operating systems design and implementation/i] },
  { label: "CCF-A", name: "SOSP", patterns: [/\bsosp\b/i, /acm symposium on operating systems principles/i] },
  { label: "CCF-A", name: "SIGCOMM", patterns: [/\bsigcomm\b/i, /acm sigcomm/i] },
  { label: "CCF-A", name: "MobiCom", patterns: [/\bmobicom\b/i, /mobile computing and networking/i] },
  { label: "CCF-A", name: "INFOCOM", patterns: [/\binfocom\b/i, /ieee infocom/i] },
  { label: "CCF-A", name: "CCS", patterns: [/\bccs\b/i, /acm conference on computer and communications security/i] },
  { label: "CCF-A", name: "USENIX Security", patterns: [/usenix\s+security/i] },
  { label: "CCF-A", name: "S&P", patterns: [/ieee symposium on security and privacy/i, /\boakland\b/i] },
  { label: "CCF-A", name: "NDSS", patterns: [/\bndss\b/i, /network and distributed system security/i] },
  { label: "CCF-A", name: "STOC", patterns: [/\bstoc\b/i, /acm symposium on theory of computing/i] },
  { label: "CCF-A", name: "FOCS", patterns: [/\bfocs\b/i, /ieee symposium on foundations of computer science/i] },
  { label: "CCF-A", name: "CHI", patterns: [/\bchi\b/i, /acm chi conference/i] },
  { label: "CCF-A", name: "SIGIR", patterns: [/\bsigir\b/i] },
  { label: "CCF-A", name: "KDD", patterns: [/\bkdd\b/i, /knowledge discovery and data mining/i] },
  { label: "CCF-A", name: "WWW", patterns: [/\bwww\b/i, /the web conference/i] },
  { label: "CCF-A", name: "SIGGRAPH", patterns: [/\bsiggraph\b/i] },
  { label: "CCF-A", name: "EuroSys", patterns: [/\beurosys\b/i] },
  { label: "CCF-A", name: "FAST", patterns: [/\bfast\b/i, /file and storage technologies/i] },
  { label: "CCF-A", name: "NSDI", patterns: [/\bnsdi\b/i, /networked systems design and implementation/i] },
  { label: "CCF-A", name: "ATC", patterns: [/\busenix atc\b/i, /annual technical conference/i] },
  { label: "CCF-A", name: "ICDE", patterns: [/\bicde\b/i, /international conference on data engineering/i] },
  // ICLR is a top ML venue but not on the CCF list; label it as a top meeting.
  { label: "顶会", name: "ICLR", patterns: [/\biclr\b/i, /international conference on learning representations/i] },
];

const CCF_B: Entry[] = [
  { label: "CCF-B", name: "ECCV", patterns: [/\beccv\b/i, /european conference on computer vision/i] },
  { label: "CCF-B", name: "EMNLP", patterns: [/\bemnlp\b/i, /empirical methods in natural language processing/i] },
  { label: "CCF-B", name: "NAACL", patterns: [/\bnaacl\b/i] },
  { label: "CCF-B", name: "COLING", patterns: [/\bcoling\b/i] },
  { label: "CCF-B", name: "UAI", patterns: [/\buai\b/i, /uncertainty in artificial intelligence/i] },
  { label: "CCF-B", name: "AISTATS", patterns: [/\baistats\b/i] },
  { label: "CCF-B", name: "COLT", patterns: [/\bcolt\b/i, /conference on learning theory/i] },
  { label: "CCF-B", name: "ICRA", patterns: [/\bicra\b/i, /international conference on robotics and automation/i] },
  { label: "CCF-B", name: "IROS", patterns: [/\biros\b/i] },
  { label: "CCF-B", name: "MM", patterns: [/\bacm multimedia\b/i, /\bmm\s*'?\d{2,4}\b/i] },
  { label: "CCF-B", name: "ICME", patterns: [/\bicme\b/i] },
  { label: "CCF-B", name: "ICASSP", patterns: [/\bicassp\b/i] },
  { label: "CCF-B", name: "INTERSPEECH", patterns: [/\binterspeech\b/i] },
  { label: "CCF-B", name: "BMVC", patterns: [/\bbmvc\b/i] },
  { label: "CCF-B", name: "MICCAI", patterns: [/\bmiccai\b/i] },
  { label: "CCF-B", name: "CIKM", patterns: [/\bcikm\b/i] },
  { label: "CCF-B", name: "WSDM", patterns: [/\bwsdm\b/i] },
  { label: "CCF-B", name: "RecSys", patterns: [/\brecsys\b/i, /acm conference on recommender systems/i] },
  { label: "CCF-B", name: "ICDCS", patterns: [/\bicdcs\b/i] },
  { label: "CCF-B", name: "ICPP", patterns: [/\bicpp\b/i] },
  { label: "CCF-B", name: "ICS", patterns: [/\bics\s*'?\d{2,4}\b/i] },
  { label: "CCF-B", name: "UIST", patterns: [/\buist\b/i] },
  { label: "CCF-B", name: "CSCW", patterns: [/\bcscw\b/i] },
];

const TOP_JOURNAL: Entry[] = [
  { label: "顶刊", name: "Nature", patterns: [/\bnature\b/i] },
  { label: "顶刊", name: "Science", patterns: [/^\s*science\b/i, /\bscience\s*\(/i] },
  { label: "顶刊", name: "Cell", patterns: [/\bcell\b/i] },
  { label: "顶刊", name: "PNAS", patterns: [/\bpnas\b/i, /proceedings of the national academy of sciences/i] },
  { label: "CCF-A", name: "TPAMI", patterns: [/\btpami\b/i, /transactions on pattern analysis and machine intelligence/i] },
  { label: "CCF-A", name: "IJCV", patterns: [/\bijcv\b/i, /international journal of computer vision/i] },
  { label: "CCF-A", name: "JMLR", patterns: [/\bjmlr\b/i, /journal of machine learning research/i] },
  { label: "CCF-A", name: "TOG", patterns: [/\btog\b/i, /acm transactions on graphics/i] },
  { label: "CCF-A", name: "TOCS", patterns: [/\btocs\b/i] },
  { label: "CCF-A", name: "TOS", patterns: [/\btos\b/i, /acm transactions on storage/i] },
  { label: "CCF-A", name: "TOC", patterns: [/\btoc\b/i, /ieee transactions on computers/i] },
  { label: "CCF-A", name: "TSE", patterns: [/\btse\b/i, /ieee transactions on software engineering/i] },
  { label: "CCF-A", name: "TKDE", patterns: [/\btkde\b/i] },
  { label: "CCF-A", name: "VLDBJ", patterns: [/\bvldbj\b/i] },
  { label: "CCF-A", name: "AIJ", patterns: [/\bartificial intelligence\b/i] },
];

const TABLES: Entry[][] = [TOP_JOURNAL, CCF_A, CCF_B];

/** Match a free-form venue string (e.g. "Proceedings of CVPR 2024"). */
export function matchVenueTier(venue?: string | null): VenueTier | null {
  if (!venue || !venue.trim()) return null;
  const text = venue.trim();
  for (const table of TABLES) {
    for (const entry of table) {
      if (entry.patterns.some((pattern) => pattern.test(text))) {
        return { label: entry.label, name: entry.name, tone: entry.label === "顶刊" ? "top-journal" : entry.label === "CCF-B" ? "ccf-b" : "ccf-a" };
      }
    }
  }
  return null;
}
