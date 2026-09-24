import { GoogleGenAI } from "@google/genai";
import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
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




async function scrapeWebpage(url = "") {
    const { data } = await axios.get(url);

    const $ = cheerio.load(data);

    const pageHead = $("head").html();
    const pageBody = $("body").html();

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

async function generateVectorEmbeddings({ text }) {
    const response = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: text,
        encoding_format: 'FLOAT',
    });
    // Ptinting Embedding
    console.log("Dimension:", response.embeddings[0].values.length);
    console.log("First 5 values:", response.embeddings[0].values.slice(0, 5));
    return response.embeddings[0].values;
}

async function ingest(url = '') {
    const { head, body, internalLinks } = await scrapeWebpage(url);
    const headEmbedding = await generateVectorEmbeddings({ text: head });

    await insertIntoDb({ embedding: headEmbedding, url });

    const bodyChunks = chunkText(body); // Made chunks because context window size is limited for embedding content and body was lengthy
    for (const chunk of bodyChunks) {
        const bodyEmbedding = await generateVectorEmbeddings({ text: chunk });
        await insertIntoDb({ embedding: bodyEmbedding, url, body: chunk, head });
    }

    for (const link of internalLinks) {
        const _url = `${url}${link}`;
        await ingest(_url);
    }
}

async function insertIntoDb({ embedding, url, body = '', head = '' }) {
    const collection = await chromadbClient.getOrCreateCollection({
        name: WEB_COLLECTION,
    });
    await collection.add({
        ids: [`${url}-0`],
        embeddings: [embedding],
        metadatas: [{ url, body, head }]
    })
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

ingest('https://prepai-app.vercel.app/');