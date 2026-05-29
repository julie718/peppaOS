import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getKey } from "../config/keys";

let openai: OpenAI | null = null;
let anthropic: Anthropic | null = null;
let gemini: GoogleGenerativeAI | null = null;
let deepseek: OpenAI | null = null;
let qwen: OpenAI | null = null;

export interface LLMClients {
  getOpenAI: () => OpenAI | null;
  getAnthropic: () => Anthropic | null;
  getGemini: () => GoogleGenerativeAI | null;
  getDeepSeek: () => OpenAI | null;
  getQwen: () => OpenAI | null;
}

function getOpenAI() {
  const key = process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY');
  if (!openai && key) {
    openai = new OpenAI({ apiKey: key });
  }
  return openai;
}

function getAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY || getKey('ANTHROPIC_API_KEY');
  if (!anthropic && key) {
    anthropic = new Anthropic({ apiKey: key });
  }
  return anthropic;
}

function getGemini() {
  if (!gemini) {
    const key = process.env.GEMINI_API_KEY || getKey('GEMINI_API_KEY');
    if (!key) return null;
    gemini = new GoogleGenerativeAI(key);
  }
  return gemini;
}

function getDeepSeek() {
  const key = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_BASE_URL
    ? process.env.DEEPSEEK_API_KEY || getKey('DEEPSEEK_API_KEY')
    : null;
  if (!deepseek && key) {
    deepseek = new OpenAI({
      apiKey: key,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    });
  }
  return deepseek;
}

function getQwen() {
  const key = process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY
    || getKey('QWEN_API_KEY') || getKey('DASHSCOPE_API_KEY');
  if (!qwen && key) {
    qwen = new OpenAI({ apiKey: key, baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
  }
  return qwen;
}

export function createLLMRuntime(): LLMClients {
  return { getOpenAI, getAnthropic, getGemini, getDeepSeek, getQwen };
}
