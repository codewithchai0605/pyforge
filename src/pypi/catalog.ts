import { canonicalName } from "./format";

/**
 * A hand-picked catalogue: what to suggest before the user has searched for
 * anything, and (through `tags`) a way to find packages by what they do
 * ("http" -> requests) rather than only by name.
 *
 * `compiled` is a hint, never a promise: those packages contain native code,
 * so they install only if an Android build exists for them. The real answer
 * comes from the lookup the details sheet runs.
 */

export type CategoryId =
  "web" | "data" | "text" | "science" | "images" | "utils" | "dev" | "fun";

export interface Category {
  id: CategoryId;
  label: string;
}

export const CATEGORIES: Category[] = [
  { id: "web", label: "Web & APIs" },
  { id: "data", label: "Data & files" },
  { id: "text", label: "Terminal & text" },
  { id: "science", label: "Science & maths" },
  { id: "images", label: "Images & documents" },
  { id: "utils", label: "Dates & helpers" },
  { id: "dev", label: "Testing & tools" },
  { id: "fun", label: "Fun" },
];

export interface CatalogItem {
  name: string;
  blurb: string;
  category: CategoryId;
  /** Extra words that should find it. */
  tags: string;
  compiled?: boolean;
}

const c = (
  category: CategoryId,
  name: string,
  blurb: string,
  tags = "",
  compiled = false,
): CatalogItem => ({
  name,
  blurb,
  category,
  tags,
  ...(compiled ? { compiled } : {}),
});

export const CATALOG: CatalogItem[] = [
  // Web & APIs
  c(
    "web",
    "requests",
    "Friendly HTTP requests",
    "http https api rest download fetch get post url",
  ),
  c(
    "web",
    "httpx",
    "Modern HTTP client, with async",
    "http https api async fetch",
  ),
  c(
    "web",
    "aiohttp",
    "Async HTTP client and server",
    "http async asyncio server",
  ),
  c(
    "web",
    "beautifulsoup4",
    "Parse HTML and XML",
    "html scraping scrape parse web crawler bs4",
  ),
  c(
    "web",
    "lxml",
    "Fast XML and HTML parser",
    "xml html xpath parse scraping",
    true,
  ),
  c("web", "flask", "Tiny web framework", "web server website app http"),
  c("web", "fastapi", "Modern API framework", "web server api rest async"),
  c("web", "websockets", "WebSocket client and server", "realtime socket chat"),
  c("web", "feedparser", "Read RSS and Atom feeds", "rss atom news blog"),
  c("web", "python-telegram-bot", "Build Telegram bots", "telegram bot chat"),
  c("web", "pyjwt", "JSON Web Tokens", "jwt token auth login security"),
  c(
    "web",
    "certifi",
    "Trusted HTTPS certificates",
    "ssl tls https certificates",
  ),
  // Data & files
  c(
    "data",
    "pandas",
    "Data tables and analysis",
    "dataframe table csv excel analysis",
    true,
  ),
  c("data", "numpy", "Fast arrays and maths", "array matrix numeric", true),
  c("data", "openpyxl", "Read and write Excel files", "excel xlsx spreadsheet"),
  c("data", "tabulate", "Pretty text tables", "table print format"),
  c("data", "pyyaml", "Read and write YAML", "yaml config settings", true),
  c(
    "data",
    "python-dotenv",
    "Load settings from .env files",
    "env environment config secrets",
  ),
  c("data", "sqlalchemy", "SQL toolkit and ORM", "database sql sqlite orm"),
  c(
    "data",
    "pydantic",
    "Data validation from type hints",
    "validation models schema types",
    true,
  ),
  c("data", "jsonschema", "Validate JSON", "json validation schema"),
  c("data", "faker", "Generate fake data", "fake test data names random"),
  c("data", "tomli", "Read TOML files", "toml config pyproject"),
  c("data", "xmltodict", "XML as Python dicts", "xml parse convert"),
  // Terminal & text
  c(
    "text",
    "rich",
    "Beautiful terminal output",
    "color colour console table progress markdown print",
  ),
  c("text", "colorama", "Coloured text output", "color colour ansi terminal"),
  c("text", "termcolor", "Coloured text, simply", "color colour ansi"),
  c("text", "tqdm", "Progress bars", "progress bar loop"),
  c("text", "click", "Build command-line tools", "cli command line arguments"),
  c(
    "text",
    "typer",
    "Command-line tools from type hints",
    "cli command line arguments",
  ),
  c(
    "text",
    "prompt-toolkit",
    "Interactive prompts",
    "input prompt repl autocomplete",
  ),
  c("text", "pyfiglet", "ASCII art banners", "ascii art banner text figlet"),
  c("text", "emoji", "Emoji by name", "emoji unicode"),
  c("text", "markdown", "Markdown to HTML", "md html convert"),
  c("text", "pygments", "Syntax highlighting", "highlight code colour"),
  c("text", "jinja2", "Text and HTML templates", "template html render"),
  c(
    "text",
    "rapidfuzz",
    "Fast fuzzy string matching",
    "fuzzy match similar levenshtein search",
    true,
  ),
  c(
    "text",
    "unidecode",
    "Turn accented text into ASCII",
    "ascii accents unicode transliterate",
  ),
  c("text", "python-slugify", "URL-friendly slugs", "slug url text"),
  c("text", "nltk", "Natural language toolkit", "nlp language words tokenize"),
  // Science & maths
  c(
    "science",
    "scipy",
    "Scientific computing",
    "science maths statistics optimize integrate",
    true,
  ),
  c(
    "science",
    "sympy",
    "Symbolic mathematics",
    "algebra calculus equations solve math",
  ),
  c("science", "mpmath", "Arbitrary-precision maths", "precision decimal math"),
  c("science", "networkx", "Graphs and networks", "graph network nodes edges"),
  c(
    "science",
    "scikit-learn",
    "Machine learning",
    "ml ai model train predict classify",
    true,
  ),
  c("science", "pint", "Units of measure", "units convert physics"),
  c(
    "science",
    "statsmodels",
    "Statistics models",
    "statistics regression",
    true,
  ),
  // Images & documents
  c(
    "images",
    "pillow",
    "Image processing",
    "image photo picture png jpg resize pil",
    true,
  ),
  c(
    "images",
    "matplotlib",
    "Charts and plots",
    "plot chart graph visualize",
    true,
  ),
  c("images", "qrcode", "Make QR codes", "qr code barcode"),
  c("images", "pypdf", "Read and edit PDFs", "pdf document merge split"),
  c("images", "fpdf2", "Create PDF files", "pdf document create generate"),
  c("images", "reportlab", "PDF reports", "pdf report document", true),
  c(
    "images",
    "python-docx",
    "Read and write Word files",
    "word docx document office",
  ),
  c("images", "svgwrite", "Draw SVG graphics", "svg vector drawing"),
  // Dates & helpers
  c(
    "utils",
    "python-dateutil",
    "Powerful date parsing",
    "date time parse timezone relative",
  ),
  c("utils", "pytz", "World time zones", "timezone time date"),
  c("utils", "arrow", "Friendlier dates and times", "date time humanize"),
  c(
    "utils",
    "humanize",
    "Human-friendly numbers and dates",
    "format size time ago",
  ),
  c(
    "utils",
    "more-itertools",
    "More tools for loops",
    "itertools iterate chunk",
  ),
  c("utils", "cachetools", "Caches and memoizing", "cache memoize speed"),
  c("utils", "tenacity", "Retry things that fail", "retry backoff"),
  c("utils", "schedule", "Run jobs on a timer", "cron timer periodic job"),
  c("utils", "attrs", "Classes without boilerplate", "dataclass class"),
  c(
    "utils",
    "psutil",
    "System and process info",
    "cpu memory battery process system",
    true,
  ),
  // Testing & tools
  c("dev", "pytest", "Write tests the easy way", "test testing unit assert"),
  c("dev", "hypothesis", "Property-based testing", "test fuzz random"),
  c("dev", "pyflakes", "Find mistakes in code", "lint check errors static"),
  c("dev", "flake8", "Style and error checker", "lint style pep8"),
  c(
    "dev",
    "packaging",
    "Versions and requirements",
    "version parse requirements",
  ),
  c("dev", "pyperclip", "Copy and paste from code", "clipboard copy paste"),
  // Fun
  c("fun", "cowsay", "A talking cow", "ascii fun cow say"),
  c("fun", "art", "ASCII art collection", "ascii art fun"),
  c("fun", "pygame", "Games and graphics", "game graphics sprite sound", true),
  c(
    "fun",
    "pyglet",
    "Windows, games and media",
    "game graphics opengl sound",
    true,
  ),
];

const CATALOG_BY_KEY = new Map(CATALOG.map((i) => [canonicalName(i.name), i]));

export const catalogItem = (name: string): CatalogItem | undefined =>
  CATALOG_BY_KEY.get(canonicalName(name));

/**
 * Catalogue entries matching every word of `query` in the name, the blurb or
 * the tags. Name matches rank first, then tag matches, then blurb matches.
 */
export function searchCatalog(query: string, limit = 12): CatalogItem[] {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const scored: Array<[number, CatalogItem]> = [];
  for (const item of CATALOG) {
    const name = canonicalName(item.name);
    const blurb = item.blurb.toLowerCase();
    const tags = ` ${item.tags} `;
    let total = 0;
    let ok = true;
    for (const w of words) {
      const key = canonicalName(w);
      if (name === key) total += 100;
      else if (name.startsWith(key)) total += 70;
      else if (name.includes(key)) total += 50;
      else if (tags.includes(` ${w} `)) total += 40;
      else if (tags.includes(w)) total += 25;
      else if (blurb.includes(w)) total += 15;
      else {
        ok = false;
        break;
      }
    }
    if (ok) scored.push([total / words.length, item]);
  }
  return scored
    .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
    .slice(0, limit)
    .map(([, item]) => item);
}
