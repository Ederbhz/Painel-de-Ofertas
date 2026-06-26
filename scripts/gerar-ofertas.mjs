import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const OUTPUT_FILE = "ofertas.json";
const SEARCH_URL = "https://api.mercadolibre.com/sites/MLB/search";
const REVIEW_URL = "https://api.mercadolibre.com/reviews/item/";
const TARGET_COUNT = Number(process.env.OFERTAS_LIMIT || 50);
const PER_QUERY_LIMIT = Number(process.env.OFERTAS_PER_QUERY_LIMIT || 30);
const ACCESS_TOKEN = process.env.MELI_ACCESS_TOKEN || "";

const SEARCH_QUERIES = (process.env.OFERTAS_QUERIES || [
  "achadinhos",
  "ofertas do dia",
  "fone bluetooth",
  "air fryer",
  "garrafa termica",
  "mochila notebook",
  "carregador turbo usb c",
  "mouse sem fio",
  "escova secadora",
  "organizador cozinha",
  "luminaria led",
  "mini processador"
].join("|"))
  .split("|")
  .map((query) => query.trim())
  .filter(Boolean);

const CATEGORY_MAP = {
  MLB1000: "Eletrônicos",
  MLB1051: "Celulares e Telefones",
  MLB1246: "Beleza e Cuidado Pessoal",
  MLB1276: "Esportes e Fitness",
  MLB1384: "Bebês",
  MLB1430: "Roupas, Bolsas e Calçados",
  MLB1574: "Casa, Móveis e Decoração",
  MLB1648: "Informática",
  MLB1743: "Carros, Motos e Outros",
  MLB1953: "Alimentos e Bebidas",
  MLB3025: "Livros, Revistas e Comics",
  MLB3937: "Joias e Relógios",
  MLB5726: "Eletrodomésticos"
};

async function main() {
  const startedAt = new Date();
  const products = await collectOffers();

  if (products.length < 3) {
    const existing = await readExistingOutput();
    if (existing?.products?.length) {
      console.warn("Poucos produtos retornados. Mantendo ofertas.json existente.");
      return;
    }
    throw new Error("A API não retornou produtos suficientes para gerar o painel.");
  }

  const payload = {
    generatedAt: startedAt.toISOString(),
    source: "mercado-livre-api",
    sourceLabel: "Mercado Livre API",
    querySet: SEARCH_QUERIES,
    total: products.length,
    products: products.slice(0, TARGET_COUNT)
  };

  await writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Arquivo ${OUTPUT_FILE} atualizado com ${payload.products.length} ofertas.`);
}

async function collectOffers() {
  const batches = await Promise.allSettled(
    SEARCH_QUERIES.map((query) => searchProducts(query))
  );

  const products = batches
    .filter((result) => result.status === "fulfilled")
    .flatMap((result) => result.value);

  const rejected = batches.filter((result) => result.status === "rejected");
  rejected.forEach((result) => console.warn(result.reason.message));

  const uniqueProducts = dedupeProducts(products)
    .filter((product) => product.link && product.preco > 0)
    .filter((product) => product.avaliacao === 0 || product.avaliacao >= 4.3 || product.vendas >= 500);

  const enriched = await mapLimit(uniqueProducts.slice(0, 80), 5, enrichWithReviews);

  return enriched
    .map((product) => {
      const pontuacao = calculateScore(product);
      return {
        ...product,
        pontuacao,
        criterioDestaque: getHighlightCriterion(product, pontuacao)
      };
    })
    .filter((product) => product.pontuacao >= 70)
    .sort((a, b) => b.pontuacao - a.pontuacao);
}

async function searchProducts(query) {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(PER_QUERY_LIMIT));
  url.searchParams.set("condition", "new");

  const data = await fetchJson(url);
  return (data.results || []).map((item) => normalizeMercadoLivreItem(item, query));
}

async function enrichWithReviews(product) {
  if (!product.id) {
    return product;
  }

  try {
    const review = await fetchJson(`${REVIEW_URL}${encodeURIComponent(product.id)}`);
    return {
      ...product,
      avaliacao: toNumber(review.rating_average ?? review.average_rating ?? product.avaliacao),
      quantidadeAvaliacoes: toNumber(review.total_reviews ?? review.total ?? review.paging?.total ?? product.quantidadeAvaliacoes)
    };
  } catch {
    return product;
  }
}

async function fetchJson(urlLike) {
  const url = String(urlLike);
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: buildHeaders()
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} em ${url}`);
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      await wait(700 * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function buildHeaders() {
  const headers = {
    Accept: "application/json",
    "User-Agent": "Painel-Ofertas-360/1.0 (+https://github.com/Ederbhz/Painel-de-Ofertas)"
  };

  if (ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${ACCESS_TOKEN}`;
  }

  return headers;
}

function normalizeMercadoLivreItem(item, query) {
  const originalPrice = toNumber(item.original_price ?? item.prices?.prices?.[0]?.regular_amount);
  const price = toNumber(item.price);
  const discount = originalPrice > price ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;

  return {
    id: item.id,
    nome: item.title || "Produto sem nome",
    preco: price,
    avaliacao: toNumber(item.reviews?.rating_average ?? item.rating_average ?? item.rating),
    quantidadeAvaliacoes: toNumber(item.reviews?.total ?? item.reviews?.total_reviews ?? item.rating_count),
    maisVendido: detectBestSeller(item),
    categoria: CATEGORY_MAP[item.category_id] || normalizeDomain(item.domain_id) || "Não informada",
    link: item.permalink,
    thumbnail: normalizeImage(item.thumbnail || item.thumbnail_id || ""),
    vendas: toNumber(item.sold_quantity),
    desconto: discount,
    lojaOficial: Boolean(item.official_store_id || item.official_store_name),
    freteGratis: Boolean(item.shipping?.free_shipping),
    reputacao: item.seller?.seller_reputation?.power_seller_status || "",
    buscaOrigem: query,
    fonte: "mercado-livre-api"
  };
}

function calculateScore(product) {
  const rating = toNumber(product.avaliacao);
  const reviews = toNumber(product.quantidadeAvaliacoes);
  const sold = toNumber(product.vendas);
  const price = toNumber(product.preco);
  const discount = toNumber(product.desconto);

  let ratingScore = 0;
  if (rating >= 4.8) ratingScore = 30;
  else if (rating >= 4.5) ratingScore = 26;
  else if (rating >= 4.3) ratingScore = 18;
  else if (rating >= 4.0) ratingScore = 10;
  else if (rating === 0 && sold >= 500) ratingScore = 14;
  else if (rating > 0) ratingScore = 4;

  let reviewScore = 0;
  if (reviews >= 1000) reviewScore = 20;
  else if (reviews >= 500) reviewScore = 18;
  else if (reviews >= 100) reviewScore = 14;
  else if (reviews >= 30) reviewScore = 9;
  else if (reviews > 0) reviewScore = 4;
  else if (sold >= 500) reviewScore = 8;

  let salesScore = 0;
  if (product.maisVendido === true) salesScore = 25;
  else if (sold >= 1000) salesScore = 23;
  else if (sold >= 500) salesScore = 18;
  else if (sold >= 100) salesScore = 14;
  else if (sold >= 30) salesScore = 8;
  else if (sold > 0) salesScore = 4;

  let priceScore = 0;
  if (price > 0 && price <= 50) priceScore = 13;
  else if (price <= 100) priceScore = 12;
  else if (price <= 200) priceScore = 10;
  else if (price <= 500) priceScore = 8;
  else if (price <= 1000) priceScore = 5;
  else if (price > 1000) priceScore = 3;
  priceScore = Math.min(15, priceScore + Math.min(4, Math.floor(discount / 8)));

  let trustScore = 0;
  if (product.lojaOficial) trustScore += 5;
  if (String(product.reputacao).toLowerCase().includes("platinum")) trustScore += 3;
  if (String(product.reputacao).toLowerCase().includes("gold")) trustScore += 2;
  if (product.freteGratis) trustScore += 2;
  trustScore = Math.min(10, trustScore);

  let score = ratingScore + reviewScore + salesScore + priceScore + trustScore;

  if (rating > 0 && rating < 4.3 && sold < 1000) score -= 16;
  if (reviews > 0 && reviews < 30) score -= 8;
  if (!product.link) score -= 14;

  return clamp(Math.round(score), 0, 100);
}

function getHighlightCriterion(product, score) {
  if (score >= 90) return "Oferta excelente para divulgar";
  if (product.maisVendido === true) return "Muito vendido";
  if (toNumber(product.avaliacao) >= 4.7 && toNumber(product.quantidadeAvaliacoes) >= 100) return "Alta avaliação";
  if (toNumber(product.preco) <= 100 || toNumber(product.desconto) >= 15) return "Bom custo-benefício";
  if (score >= 80) return "Oferta forte para divulgação";
  return "Avaliar antes de divulgar";
}

function detectBestSeller(item) {
  const tags = [
    ...(item.tags || []),
    ...(item.attributes || []).map((attribute) => attribute.value_name || attribute.name || "")
  ].join(" ").toLowerCase();

  return tags.includes("best_seller")
    || tags.includes("mais vendido")
    || tags.includes("meli_choice")
    || toNumber(item.sold_quantity) >= 1000;
}

function dedupeProducts(products) {
  const seen = new Set();
  return products.filter((product) => {
    const key = product.id || product.link || product.nome;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readExistingOutput() {
  if (!existsSync(OUTPUT_FILE)) {
    return null;
  }

  try {
    return JSON.parse(await readFile(OUTPUT_FILE, "utf8"));
  } catch {
    return null;
  }
}

function normalizeDomain(domainId) {
  if (!domainId) return "";

  return String(domainId)
    .replace(/^MLB-/, "")
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeImage(value) {
  if (!value) return "";
  if (String(value).startsWith("http://")) return String(value).replace(/^http:/, "https:");
  if (String(value).startsWith("https://")) return String(value);
  return "";
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const number = Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
