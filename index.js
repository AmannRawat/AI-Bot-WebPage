import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import readlineSync from "readline-sync";
import { ChromaClient } from "chromadb";

// dotenv.config();

export const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
});

const chromadbClient = new ChromaClient({
    host: "localhost",
    port: 8000,
    ssl: false,
});
chromadbClient.heartbeat();

const WEB_COLLECTION = 'WEB_SCRAPED_DATA_COLLECTION-1'

const visitedUrls = new Set();
function normalizeUrl(url) {
    const u = new URL(url);

    // Remove hash (#about)
    u.hash = "";

    // Remove trailing slash except root
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
        u.pathname = u.pathname.slice(0, -1);
    }

    return u.href;
}

//Delete the collection if already exists only for development phase
try {
    await chromadbClient.deleteCollection({
        name: WEB_COLLECTION,
    });
} catch { }

const collection = await chromadbClient.getOrCreateCollection({
    name: WEB_COLLECTION,
});


//This function is only for server side rendering webpages!
async function scrapeStaticWebsite(url = "") {
    // Static websites → Axios
    const { data } = await axios.get(url);

    const $ = cheerio.load(data);

    const pageHead = $("head").html();
    const pageBody = $("body").text().replace(/\s+/g, " ").trim();

    const internalLinks = [];
    const externalLinks = [];
    $('a').each((index, element) => {
        const link = $(element).attr('href')
        if (link === '/' || link === '#') return;
        if (link?.startsWith('http') || link?.startsWith('https')) {
            externalLinks.push(link);
        } else {
            internalLinks.push(link);
        }
    })
    return { head: pageHead, body: pageBody, internalLinks, externalLinks };
}
//This function for client side rendering web pages like React Vite
async function scrapeReactWebsite(url = "") {
    const browser = await puppeteer.launch({
        headless: true,
    });

    const page = await browser.newPage();

    await page.goto(url, {
        waitUntil: "networkidle2",
    });

    const html = await page.content();
    const $ = cheerio.load(html);

    const pageHead = $("head").html();

    const pageBody = await page.evaluate(() =>
        document.body.innerText.replace(/\s+/g, " ").trim()
    );

    // console.log("Characters:", pageBody.length);
    // console.log("Preview:", pageBody.slice(0, 300));

    await browser.close();

    const internalLinks = [];
    const externalLinks = [];

    $("a").each((_, element) => {
        const link = $(element).attr("href");

        if (!link) return;

        // Skip anchors, email, phone and JS links
        if (
            link.startsWith("#") ||
            link.startsWith("mailto:") ||
            link.startsWith("tel:") ||
            link.startsWith("javascript:")
        ) {
            return;
        }

        if (link.startsWith("http")) {
            externalLinks.push(link);
        } else {
            internalLinks.push(link);
        }
    });

    return {
        head: pageHead,
        body: pageBody,
        internalLinks,
        externalLinks,
    };
}

async function generateVectorEmbeddings({ text }) {
    const response = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: text,
        encoding_format: 'FLOAT',
    });
    // Ptinting Embedding
    // console.log("Dimension:", response.embeddings[0].values.length);
    // console.log("First 5 values:", response.embeddings[0].values.slice(0, 5));
    return response.embeddings[0].values;
}

async function ingest(url = '') {
    url = normalizeUrl(url);
    if (visitedUrls.has(url)) return;
    visitedUrls.add(url);
    const { head, body, internalLinks } = await scrapeReactWebsite(url);
    const headEmbedding = await generateVectorEmbeddings({ text: head });

    await insertIntoDb({
        id: `${url}-head`,
        embedding: headEmbedding,
        url,
        body: head,
        head
    });

    const bodyChunks = chunkText(body); // Made chunks because context window size is limited for embedding content and body was lengthy

    for (const [chunkIndex, chunk] of bodyChunks.entries()) {
        if (!chunk.trim()) continue;
        const bodyEmbedding = await generateVectorEmbeddings({ text: chunk });
        await insertIntoDb({
            id: `${url}-${chunkIndex}`,
            embedding: bodyEmbedding,
            url,
            body: chunk,
            head
        });
    }

    for (const link of internalLinks) {
        const _url = normalizeUrl(new URL(link, url).href);
        await ingest(_url);
    }
    console.log("Crawling:", url);
}

async function insertIntoDb({ id, embedding, url, body = '', head = '' }) {
    await collection.add({
        ids: [id],
        embeddings: [embedding],
        documents: [body],
        metadatas: [{ url, head }]
    });
    // count the no. of vectors in the collection
    const count = await collection.count();
    console.log("Vectors in DB:", count);
}


export function chunkText(text, chunkSize = 300) {
    const tokens = text
        .replace(/\s+/g, " ")
        .trim()
        .split(" ");

    const chunks = [];

    for (let i = 0; i < tokens.length; i += chunkSize) {
        chunks.push(tokens.slice(i, i + chunkSize).join(" "));
    }

    return chunks;
}

console.log("🚀 Starting ingestion...");
await ingest('https://anupbh77.github.io');

async function chat(question = '') {
    const questionEmbedding = await generateVectorEmbeddings({ text: question });
    const collectionResult = await collection.query({
        queryEmbeddings: [questionEmbedding],
        nResults: 3,
        include: ['metadatas', 'documents']
    })

    // console.log("Retrieved:", JSON.stringify(collectionResult, null, 2));

    const body = collectionResult.documents[0]
        .filter((e) => e && e.trim() !== "");

    const url = collectionResult.metadatas[0]
        .map((e) => e.url)
        .filter((e) => e && e.trim() !== "");

    const chatSession = ai.chats.create({
        model: "gemini-3.5-flash-lite",
        config: {
            systemInstruction: `You are an AI support agent expert in providing support to users on behalf of the webpage. Answer the user's question only from the retrieved context.`
        },
        history: []
    });

    const response = await chatSession.sendMessage({
        message: `
    Query: ${question}
    URLs: ${url.join(", ")}
    Retrieved Context: ${body.join("\n\n")}
`
    });

    console.log("\n" + "═".repeat(60));
    console.log("🤖  AI SUPPORT AGENT");
    console.log("═".repeat(60));

    console.log("\n" + response.text);

    console.log("\n🔗 Source:", url[0]);
    console.log("═".repeat(60));
}

// await chat("What this App Does?");
// await chat("Tell me about Anup who is he what does he do?");

while (true) {
    const question = readlineSync.question("\n💭 You: ");

    if (question.toLowerCase() === "exit") {
        console.log("\n👋 Goodbye!");
        break;
    }

    await chat(question);
}