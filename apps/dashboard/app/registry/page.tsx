"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Globe, Search } from "lucide-react";

const API_BASE_URL = process.env.NEXT_PUBLIC_FLOAT_API_URL?.trim() || "http://127.0.0.1:8787";
const border = { border: "1px solid #EAEAEA" };

type RegistryEntry = {
  id: string;
  name: string;
  provider: string;
  description: string;
  category: string;
  endpoint: string;
  openapiUrl: string;
  pricePerCall: string;
  pricingMode: "fixed" | "dynamic";
  priceMin?: string | null;
  priceMax?: string | null;
  protocols: string[];
  logoUrl?: string | null;
  website?: string | null;
  docsUrl?: string | null;
  guidance: string;
  status: "active" | "pending" | "inactive";
  sortOrder: number;
  createdAt: string;
};

const CATEGORIES = ["All", "AI", "Analytics", "Data", "Infrastructure", "DeFi", "Other"];

const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  AI:             { bg: "#EDF3EC", text: "#346538" },
  Analytics:      { bg: "#EEF2FF", text: "#4338CA" },
  Data:           { bg: "#FFF7ED", text: "#C2410C" },
  Infrastructure: { bg: "#F0F9FF", text: "#0369A1" },
  DeFi:           { bg: "#FDF4FF", text: "#7E22CE" },
  Other:          { bg: "#F7F6F3", text: "#787774" },
};

const PROTOCOL_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  x402: { bg: "#F7F6F3", text: "#111111", border: "#EAEAEA" },
  mpp:  { bg: "#EDF3EC", text: "#346538", border: "#C6DEC7" },
};

function ProviderLogo({ provider, logoUrl }: { provider: string; logoUrl?: string | null }) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={provider}
        className="w-9 h-9 rounded-lg object-contain"
        style={{ border: "1px solid #EAEAEA" }}
      />
    );
  }

  // Deterministic color from provider name
  const hue = provider.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  const bg = `hsl(${hue}, 60%, 94%)`;
  const text = `hsl(${hue}, 50%, 35%)`;

  return (
    <div
      className="w-9 h-9 rounded-lg flex items-center justify-center text-[13px] font-bold shrink-0"
      style={{ background: bg, color: text }}
    >
      {provider.slice(0, 2).toUpperCase()}
    </div>
  );
}

function RegistryCard({ entry }: { entry: RegistryEntry }) {
  const catColor = CATEGORY_COLORS[entry.category] ?? CATEGORY_COLORS["Other"];
  const priceDisplay =
    entry.pricingMode === "dynamic" && entry.priceMin && entry.priceMax
      ? `$${entry.priceMin}–$${entry.priceMax}`
      : `$${entry.pricePerCall}`;

  return (
    <div
      className="bg-white rounded-lg p-5 flex flex-col gap-4 transition-shadow duration-150 hover:shadow-sm"
      style={border}
    >
      {/* Top row */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderLogo provider={entry.provider} logoUrl={entry.logoUrl} />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold truncate" style={{ color: "#111111" }}>
              {entry.name}
            </p>
            <p className="text-[11px] mt-0.5 truncate" style={{ color: "#787774" }}>
              {entry.provider}
            </p>
          </div>
        </div>

        {/* Category badge */}
        <span
          className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
          style={{ background: catColor.bg, color: catColor.text }}
        >
          {entry.category}
        </span>
      </div>

      {/* Description */}
      <p className="text-[12px] leading-relaxed line-clamp-2" style={{ color: "#787774" }}>
        {entry.description}
      </p>

      {/* Guidance box */}
      <div
        className="rounded-md px-3 py-2.5 text-[11px] leading-relaxed line-clamp-3"
        style={{ background: "#F7F6F3", color: "#787774" }}
      >
        <span className="font-semibold uppercase tracking-wider text-[10px]" style={{ color: "#111111" }}>
          Agent guidance ·{" "}
        </span>
        {entry.guidance}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 pt-1">
        {/* Protocols + price */}
        <div className="flex items-center gap-2">
          {entry.protocols.map((p) => {
            const pc = PROTOCOL_COLORS[p.toLowerCase()] ?? PROTOCOL_COLORS["x402"];
            return (
              <span
                key={p}
                className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider"
                style={{ background: pc.bg, color: pc.text, border: `1px solid ${pc.border}` }}
              >
                {p}
              </span>
            );
          })}
          <span className="text-[12px] font-semibold" style={{ color: "#111111" }}>
            {priceDisplay}
            <span className="text-[11px] font-normal ml-0.5" style={{ color: "#787774" }}>
              / call
            </span>
          </span>
        </div>

        {/* Links */}
        <div className="flex items-center gap-1">
          {entry.website && (
            <a
              href={entry.website}
              target="_blank"
              rel="noopener noreferrer"
              title="Website"
              className="p-1.5 rounded-md transition-colors duration-150"
              style={{ color: "#787774" }}
            >
              <Globe size={13} />
            </a>
          )}
          {entry.docsUrl && (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Docs"
              className="p-1.5 rounded-md transition-colors duration-150 flex items-center gap-1 text-[11px] font-medium"
              style={{ color: "#787774", border: "1px solid #EAEAEA", borderRadius: 6 }}
            >
              Docs <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-lg p-5 flex flex-col gap-4 animate-pulse" style={border}>
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg" style={{ background: "#F7F6F3" }} />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 rounded w-32" style={{ background: "#F7F6F3" }} />
          <div className="h-2.5 rounded w-20" style={{ background: "#F7F6F3" }} />
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="h-2.5 rounded w-full" style={{ background: "#F7F6F3" }} />
        <div className="h-2.5 rounded w-3/4" style={{ background: "#F7F6F3" }} />
      </div>
      <div className="h-16 rounded-md" style={{ background: "#F7F6F3" }} />
      <div className="flex items-center gap-2">
        <div className="h-5 rounded w-14" style={{ background: "#F7F6F3" }} />
        <div className="h-5 rounded w-14" style={{ background: "#F7F6F3" }} />
      </div>
    </div>
  );
}

export default function RegistryPage() {
  const [entries, setEntries]     = useState<RegistryEntry[]>([]);
  const [loading, setLoading]     = useState(true);
  const [category, setCategory]   = useState("All");
  const [search, setSearch]       = useState("");

  useEffect(() => {
    setLoading(true);
    const url =
      category !== "All"
        ? `${API_BASE_URL}/v1/registry?category=${encodeURIComponent(category)}`
        : `${API_BASE_URL}/v1/registry`;

    fetch(url, { cache: "no-store" })
      .then((r) => r.json())
      .then((payload: { entries?: RegistryEntry[] }) => {
        setEntries(payload.entries ?? []);
        setLoading(false);
      })
      .catch(() => {
        setEntries([]);
        setLoading(false);
      });
  }, [category]);

  const filtered = entries.filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      e.provider.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  });

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">

      {/* Header */}
      <div className="mb-8 flex items-end justify-between gap-4">
        <div>
          <p
            className="text-[11px] font-medium uppercase tracking-widest mb-1"
            style={{ color: "#787774" }}
          >
            Discovery
          </p>
          <h2
            className="text-[22px] font-semibold tracking-tight"
            style={{ color: "#111111" }}
          >
            Float Registry
          </h2>
          <p className="text-[13px] mt-1" style={{ color: "#787774" }}>
            APIs your agents can discover, call, and pay for autonomously via x402.
          </p>
        </div>

        <a
          href="mailto:hello@usefloat.xyz?subject=Register my API on Float Registry"
          className="shrink-0 px-4 py-2 rounded-md text-[12px] font-semibold tracking-wide transition-all duration-150 active:scale-[0.97]"
          style={{ background: "#111111", color: "#fff" }}
        >
          Register your API
        </a>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-2 rounded-md flex-1 min-w-[200px] max-w-xs"
          style={{ border: "1px solid #EAEAEA", background: "#fff" }}
        >
          <Search size={13} style={{ color: "#787774" }} />
          <input
            type="text"
            placeholder="Search APIs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 text-[13px] outline-none bg-transparent"
            style={{ color: "#111111" }}
          />
        </div>

        {/* Category tabs */}
        <div
          className="flex items-center rounded-md overflow-hidden"
          style={{ border: "1px solid #EAEAEA", background: "#fff" }}
        >
          {CATEGORIES.map((cat, i) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="px-3 py-2 text-[12px] font-medium transition-colors duration-150"
              style={{
                color: category === cat ? "#111111" : "#787774",
                background: category === cat ? "#F7F6F3" : "transparent",
                borderRight: i < CATEGORIES.length - 1 ? "1px solid #EAEAEA" : "none",
              }}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-lg overflow-hidden" style={border}>
          <div className="px-6 py-16 text-center">
            <p className="text-[13px] font-medium mb-1" style={{ color: "#111111" }}>
              No APIs found
            </p>
            <p className="text-[12px]" style={{ color: "#787774" }}>
              {search
                ? `No results for "${search}"`
                : "No APIs registered in this category yet."}
            </p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((entry) => (
            <RegistryCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}

      {/* Footer count */}
      {!loading && filtered.length > 0 && (
        <p className="text-[11px] mt-6" style={{ color: "#787774" }}>
          {filtered.length} {filtered.length === 1 ? "API" : "APIs"} registered
          {search && ` matching "${search}"`}
        </p>
      )}
    </div>
  );
}
