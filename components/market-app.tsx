"use client";

import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import {
  Activity, ArrowDownWideNarrow, ArrowRight, BarChart3, Bell,
  Bitcoin, Check, ChevronDown, CircleDot, CircleHelp, Cpu, Droplet, ExternalLink,
  Clapperboard, Flame, Hexagon, Menu, Search, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Trash2, Trophy, X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PredictionMarketCard } from "@/components/motion/prediction-market-card";
import { categories, type Market, type ParlayLeg } from "@/lib/markets";
import { cn } from "@/lib/utils";
import type { SignedSolanaQuote } from "@/lib/solana-transaction";

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC_URL || "https://api.devnet.solana.com";

function isMarket(value: unknown): value is Market {
  if (!value || typeof value !== "object") return false;
  const market = value as Record<string, unknown>;
  if (typeof market.id !== "string" || typeof market.title !== "string" || !market.title.trim()) return false;
  if (market.venue !== "Kalshi" && market.venue !== "Polymarket") return false;
  if (!market.id.startsWith(market.venue === "Kalshi" ? "kalshi:" : "polymarket:")) return false;
  if (typeof market.closeTime !== "string" || !Number.isFinite(Date.parse(market.closeTime)) || Date.parse(market.closeTime) <= Date.now()) return false;
  if (typeof market.category !== "string" || typeof market.date !== "string" || typeof market.expires !== "string") return false;
  if (typeof market.volume !== "string" || typeof market.volumeSort !== "number" || !Number.isFinite(market.volumeSort) || market.volumeSort < 0) return false;
  if (typeof market.marketCount !== "number" || !Number.isFinite(market.marketCount)) return false;
  if (typeof market.image !== "string" || (market.displayType !== "teams" && market.displayType !== "thresholds")) return false;
  return Array.isArray(market.outcomes) && market.outcomes.length > 0 && market.outcomes.every((outcome) =>
    Boolean(outcome && typeof outcome === "object" && typeof (outcome as Record<string, unknown>).label === "string"),
  );
}

function tokenMicros(value: string | null | undefined): bigint | null {
  if (!value || !/^(\d+)(?:\.(\d{1,6}))?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

function formatTestTokens(micros: bigint): string {
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const rounded = (absolute + 5_000n) / 10_000n;
  const value = `${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
  return negative ? `âˆ’${value}` : value;
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number=0n;
  for(const byte of bytes) number=(number<<8n)+BigInt(byte);
  let encoded="";
  while(number>0n){const digit=Number(number%58n);encoded=alphabet[digit]!+encoded;number/=58n;}
  for(const byte of bytes){if(byte!==0)break;encoded=`1${encoded}`;}
  return encoded;
}

const iconByImage: Record<string, typeof Bitcoin> = {
  sports: CircleDot, football: CircleDot, baseball: CircleDot, basketball: Trophy,
  boxing: ShieldCheck, bitcoin: Bitcoin, oil: Droplet, ethereum: Hexagon,
  solana: Activity, xrp: Activity, ai: Sparkles, person: CircleHelp, chip: Cpu,
  netflix: Clapperboard, nasdaq: Activity, chart: BarChart3,
};

function Brand() {
  return <Link href="/" className="brand-link" aria-label="Gargantua home">
    <Image className="totalis-mark" src="/totalis-star.png" alt="" width={1535} height={1024} priority />
    <span className="brand-wordmark">Gargantua</span><span className="brand-pulse">.markets</span>
  </Link>;
}

function CategoryBar({ active, onChange, onFilters }: { active: string; onChange: (value: string) => void; onFilters: (value: string) => void }) {
  return <div className="category-row hide-scrollbar">
    <div className="flex min-w-max items-center gap-5 sm:gap-7">
      {categories.map((category) => <button key={category} onClick={() => onChange(category)} className={cn("category-item", active === category && "category-item-active")}>{category}</button>)}
    </div>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><Button variant="outline" size="sm" className="ml-auto h-8 rounded-full border-white/10 bg-white/[.035] px-2.5 text-white/75"><SlidersHorizontal size={14} /><ChevronDown size={12} /></Button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={9} className="menu-content">
        <DropdownMenu.Label className="menu-label">Filter markets</DropdownMenu.Label>
        <DropdownMenu.Item className="menu-item" onSelect={() => onFilters("Popular")}>Popular markets <Flame size={15} /></DropdownMenu.Item>
        <DropdownMenu.Item className="menu-item" onSelect={() => onFilters("Closing soon")}>Closing soon <Activity size={15} /></DropdownMenu.Item>
        <DropdownMenu.Separator className="my-1 border-t border-white/10" />
        <DropdownMenu.Item className="menu-item" onSelect={() => onFilters("All venues")}>All venues <Check size={15} /></DropdownMenu.Item>
        <DropdownMenu.Item className="menu-item" onSelect={() => onFilters("Kalshi")}>Kalshi</DropdownMenu.Item>
        <DropdownMenu.Item className="menu-item" onSelect={() => onFilters("Polymarket")}>Polymarket</DropdownMenu.Item>
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>;
}

function PriceChip({ side, selected, onClick }: { side:"Yes"|"No"; selected:boolean; onClick:()=>void }) {
  return <button onClick={onClick} aria-pressed={selected} className={cn("price-chip", side === "Yes" ? "price-yes" : "price-no", selected && "price-chip-selected")}>
    <span>{side}</span>
  </button>;
}

function EventIcon({ image, imageUrl }: { image:string; imageUrl?:string }) {
  if (imageUrl) return <span className="event-icon event-icon-photo"><img src={imageUrl} alt="" loading="lazy" /></span>;
  const Icon = iconByImage[image] ?? BarChart3;
  const mark = image === "sports" || image === "football" ? "âœº" : image === "bitcoin" ? "â‚¿" : image === "ethereum" ? "â—†" : image === "solana" ? "â‰‹" : image === "xrp" ? "X" : image === "ai" ? "â—Ž" : "";
  return <span className={cn("event-icon", `event-icon-${image}`)}><Icon size={image === "sports" || image === "football" ? 22 : 18} strokeWidth={2} />{mark && <b aria-hidden="true">{mark}</b>}</span>;
}

function MarketCard({ market, onToggle, onDetails }: { market: Market; legs: ParlayLeg[]; onToggle: (market:Market,outcome:string,side:"Yes"|"No")=>void; onDetails:()=>void }) {
  return <PredictionMarketCard
    className="market-card prediction-market-card"
    title={market.title}
    icon={<EventIcon image={market.image} imageUrl={market.imageUrl}/>}
    category={market.venue}
    status={market.date}
    volume={market.volume==="-"?"n/a":market.volume}
    outcomes={[{id:"Yes",label:"Yes"},{id:"No",label:"No"}]}
    onTitleClick={onDetails}
    onOutcomeClick={({side})=>onToggle(market,"Yes",side==="yes"?"Yes":"No")}
  />;
}
function AppDialog({ open, onOpenChange, title, children }: { open:boolean; onOpenChange:(open:boolean)=>void; title:string; children:React.ReactNode }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay"/><Dialog.Content className="dialog-content">
      <div className="mb-5 flex items-center justify-between"><Dialog.Title className="text-lg font-semibold tracking-tight">{title}</Dialog.Title><Dialog.Close asChild><button className="rounded-full p-2 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Close"><X size={17}/></button></Dialog.Close></div>
      {children}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

function ParlayPanel({ legs, removeLeg, clearLegs, submitParlay, submitting, amount, setAmount, marketList, tradingAvailable }: {
  legs:ParlayLeg[];
  removeLeg:(leg:ParlayLeg)=>void;
  clearLegs:()=>void;
  submitParlay:()=>void;
  submitting:boolean;
  marketList:Market[];
  amount:string;
  setAmount:(value:string)=>void;
  tradingAvailable:boolean;
}) {
  const amountId=useId();
  return <aside className="parlay-panel">
    <div className="parlay-title-row"><h2>Your Parlay</h2>{legs.length>0&&<><span className="parlay-count">{legs.length} {legs.length===1?"Leg":"Legs"}</span><div className="parlay-actions"><button aria-label="Share parlay" onClick={()=>void navigator.clipboard?.writeText(window.location.href)}><Share2 size={14}/></button><button aria-label="Clear parlay" onClick={clearLegs}><Trash2 size={14}/></button></div></>}</div>
    {legs.length ? <>
      <div className="parlay-leg-list">{legs.map((leg)=>{
        const market=marketList.find((entry)=>entry.id===leg.marketId);
        return <div key={`${leg.marketId}-${leg.outcome}`} className="parlay-leg">
        <EventIcon image={market?.image??"sports"}/><div className="min-w-0 flex-1"><p>{market?.title??leg.title}</p><small>{leg.outcome} <b>{leg.side}</b></small></div><button onClick={()=>removeLeg(leg)} aria-label="Remove leg"><X size={13}/></button>
      </div>})}</div>
      <p className="parlay-footnote">A fresh signed venue quote is required to show prices or payout. No estimate is shown from catalog data.</p>
      <label className="stake-label" htmlFor={amountId}>Stake (Devnet test-token units)</label>
      <div className="stake-input-wrap"><input id={amountId} type="number" min="0" step="any" placeholder="Enter stake units" value={amount} disabled={!tradingAvailable} onChange={(event)=>setAmount(event.target.value)} aria-label="Stake in Devnet test-token units" /></div>
      <Button disabled={!tradingAvailable||submitting||legs.length<2} onClick={submitParlay} className="quote-button">{!tradingAvailable?"Trading unavailable":submitting?"Confirm in wallet":"Get live quote"}</Button>
      {!tradingAvailable&&<p className="parlay-footnote">Trading is disabled because the authenticated wallet and quote flow are not configured.</p>}
    </> : <div className="parlay-empty"><p>No legs selected</p><span>Tap <b className="text-emerald-400">Yes</b> or <b className="text-red-400">No</b> to add a leg</span></div>}
  </aside>;
}

function LeaderboardPage() {
  return <main className="dashboard-page leaderboard-page">
    <div className="dashboard-heading"><div><span className="hero-kicker"><i/> COMMUNITY</span><h1>Leaderboard</h1></div></div>
    <section className="leaderboard-card" aria-label="Leaderboard unavailable">
      <div className="activity-empty"><span className="empty-orbit"><Trophy size={20}/></span><h2>Verified rankings are unavailable</h2><p>No live leaderboard API or approved public performance data is connected. Rankings will appear here only after they can be calculated from verified settled positions.</p></div>
    </section>
  </main>;
}

type PortfolioPosition = { id:string; stake:string; multiplier:string; quotedPayout:string; payout:string|null; status:string; createdAt:string; settledAt:string|null; legs:Array<{title:string;venue:string;side:string;result:string}> };

function PortfolioPage({ notify, login, authenticated, walletAddress, getAccessToken }: { notify:(message:string)=>void; login:()=>void; authenticated:boolean; walletAddress?:string; getAccessToken:()=>Promise<string|null> }) {
  const [period,setPeriod]=useState("1W");
  const [view,setView]=useState<"Positions"|"History">("Positions");
  const [status,setStatus]=useState("All");
  const [sort,setSort]=useState("Newest");
  const [positions,setPositions]=useState<PortfolioPosition[]>([]);
  const [positionsLoading,setPositionsLoading]=useState(false);
  const [positionsUnavailable,setPositionsUnavailable]=useState(false);
  const [reloadPositions,setReloadPositions]=useState(0);
  const [tokenBalance,setTokenBalance]=useState<string|null>(null);

  useEffect(()=>{
    if(!authenticated) { setPositions([]);setPositionsUnavailable(false); return; }
    if(!API_URL) { setPositionsUnavailable(true);setPositionsLoading(false);return; }
    let cancelled=false;
    setPositionsLoading(true);
    void (async()=>{
      const token=await getAccessToken();
      if(!token) throw new Error("Session expired");
      const response=await fetch(`${API_URL}/api/solana/parlays?limit=50`,{headers:{authorization:`Bearer ${token}`},cache:"no-store"});
      if(!response.ok) throw new Error("Portfolio unavailable");
      const data=await response.json() as {parlays:PortfolioPosition[]};
      if(!cancelled) {setPositions(data.parlays);setPositionsUnavailable(false);}
    })().catch(()=>{if(!cancelled)setPositionsUnavailable(true);}).finally(()=>{if(!cancelled)setPositionsLoading(false);});
    return ()=>{cancelled=true;};
  },[authenticated,getAccessToken,reloadPositions]);

  useEffect(()=>{
    const mintAddress=process.env.NEXT_PUBLIC_SOLANA_ESCROW_MINT;
    if(!walletAddress||!mintAddress)return;
    let cancelled=false;
    void (async()=>{
      try {
        const [{Connection,PublicKey},{getAssociatedTokenAddressSync}]=await Promise.all([import("@solana/web3.js"),import("@solana/spl-token")]);
        const connection=new Connection(RPC_URL,"confirmed");
        const mint=new PublicKey(mintAddress);
        const owner=new PublicKey(walletAddress);
        const ata=getAssociatedTokenAddressSync(mint,owner);
        if(!(await connection.getAccountInfo(ata,"confirmed"))) {if(!cancelled)setTokenBalance("0.00");return;}
        const balance=await connection.getTokenAccountBalance(ata,"confirmed");
        if(!cancelled)setTokenBalance(balance.value.uiAmountString??null);
      } catch { if(!cancelled)setTokenBalance(null); }
    })();
    return ()=>{cancelled=true;};
  },[walletAddress]);

  const filteredPositions=positions.filter((position)=>(view!=="History"||position.status!=="open")&&(status==="All"||(status==="Active"&&position.status==="open")||(status==="Settled"&&position.status!=="open")));
  const orderedPositions=sort==="Oldest"?[...filteredPositions].reverse():sort==="Largest"?[...filteredPositions].sort((a,b)=>Number(b.stake)-Number(a.stake)):filteredPositions;
  const periodDays=period==="1D"?1:period==="1W"?7:period==="1M"?30:Number.POSITIVE_INFINITY;
  const periodStart=Date.now()-periodDays*24*60*60*1000;
  const settledInPeriod=positions.filter((position)=>position.status!=="open"&&(!Number.isFinite(periodStart)||new Date(position.settledAt??position.createdAt).getTime()>=periodStart));
  const realizedPnl=settledInPeriod.reduce<bigint|null>((sum,position)=>{
    const payout=tokenMicros(position.payout),stake=tokenMicros(position.stake);
    return sum===null||payout===null||stake===null?null:sum+payout-stake;
  },0n);
  const openStake=positions.filter((position)=>position.status==="open").reduce<bigint|null>((sum,position)=>{
    const stake=tokenMicros(position.stake);
    return sum===null||stake===null?null:sum+stake;
  },0n);
  return <main className="dashboard-page portfolio-page">
    <div className="dashboard-heading"><div><span className="hero-kicker"><i/> YOUR PERFORMANCE</span><h1>Portfolio</h1></div><span className="portfolio-wallet">{authenticated&&walletAddress?`${walletAddress.slice(0,5)}â€¦${walletAddress.slice(-5)}`:"PRIVATE ACCOUNT"}</span></div>
    <div className="portfolio-overview">
      <section className="overview-card balance-card">
        <div className="overview-card-head"><div><span className="overview-label">Escrow token balance</span><h1>{tokenBalance===null?"â€”":tokenBalance}</h1></div><button className="share-button" onClick={()=>walletAddress&&navigator.clipboard?void navigator.clipboard.writeText(walletAddress).then(()=>notify("Wallet address copied.")).catch(()=>notify("Clipboard is unavailable in this browser.")):notify(walletAddress?"Clipboard is unavailable in this browser.":"Sign in and connect a Solana wallet first.")}><Share2 size={13}/> Copy address</button></div>
        <div className="balance-breakdown"><div><span>Escrow test-token units</span><b className="positive">{tokenBalance===null?(walletAddress?"â€”":"Connect wallet"):tokenBalance}</b></div><div><span>Stake in open positions</span><b>{authenticated&&openStake!==null?`${formatTestTokens(openStake)} test-token units`:"â€”"}</b></div></div>
        <div className="balance-actions"><button className="deposit-action" disabled title="Funding flow is not enabled on this devnet build"><ArrowRight size={16} className="rotate-down"/> Funding soon</button><button disabled title="Withdrawals are issued by on-chain settlement">Withdraw</button></div>
      </section>
      <section className="overview-card pnl-card">
        <div className="pnl-heading"><div><h2><i/>Devnet test-token result</h2><b className={`pnl-value ${realizedPnl!==null&&realizedPnl<0n?"negative":"positive"}`}>{settledInPeriod.length&&realizedPnl!==null?`${realizedPnl>0n?"+":""}${formatTestTokens(realizedPnl)} test-token units`:"â€”"}</b><p>{period==="1W"?"Past Week":period==="1D"?"Today":period==="1M"?"Past Month":"All Time"}</p></div><div className="pnl-periods">{["1D","1W","1M","ALL"].map((item)=><button className={period===item?"active":""} onClick={()=>setPeriod(item)} key={item}>{item}</button>)}</div></div>
        <div className="pnl-chart"><span>{settledInPeriod.length?`${settledInPeriod.length} settled position${settledInPeriod.length===1?"":"s"} in this period`:`No settled positions in the ${period==="1W"?"past week":period==="1D"?"past day":period==="1M"?"past month":"selected period"}`}</span></div>
      </section>
    </div>
    <section className="portfolio-activity">
      <div className="activity-toolbar"><div className="activity-tabs"><button className={view==="Positions"?"active":""} onClick={()=>setView("Positions")}>Positions</button><button className={view==="History"?"active":""} onClick={()=>setView("History")}>History</button></div>
        <div className="activity-filters">{["All","Active","Settled","Expired"].map((item)=><button className={status===item?"active":""} onClick={()=>setStatus(item)} key={item}>{item}</button>)}
          <DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="outline" size="sm" className="activity-sort">{sort}<ChevronDown size={13}/></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" className="menu-content"><DropdownMenu.Item className="menu-item" onSelect={()=>setSort("Newest")}>Newest</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>setSort("Oldest")}>Oldest</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>setSort("Largest")}>Largest</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
        </div>
      </div>
      {positionsLoading?<div className="positions-skeleton" aria-label="Loading positions">{[0,1,2].map((item)=><i key={item}/>)}</div>:orderedPositions.length?<div className="position-list">{orderedPositions.map((position)=><article className="position-row" key={position.id}><div className="position-main"><span className={`position-status ${position.status}`}>{position.status}</span><b>{position.legs.map((leg)=>leg.title).join(" Â· ")||`${position.legs.length} leg parlay`}</b><small>{new Date(position.createdAt).toLocaleDateString()} Â· {position.legs.length} legs Â· Devnet test token</small></div><div className="position-values"><span>Stake <b>{tokenMicros(position.stake)===null?"Unavailable":`${formatTestTokens(tokenMicros(position.stake)!)} test-token units`}</b></span><span>Quoted payout <b>{tokenMicros(position.quotedPayout)===null?"Unavailable":`${formatTestTokens(tokenMicros(position.quotedPayout)!)} test-token units`}</b></span></div></article>)}</div>:<div className="activity-empty"><span className="empty-orbit"><Activity size={20}/></span><h2>{positionsUnavailable?"Couldnâ€™t load your positions":authenticated?(view==="Positions"?"Your next great call starts here":"No settled positions yet"):"Your portfolio starts with you"}</h2><p>{positionsUnavailable?"Check your connection and try again.":authenticated?"Your live positions will appear here as soon as you build a parlay.":"Sign in to see your positions, activity, and performance."}</p>{positionsUnavailable&&<button className="empty-action" onClick={()=>setReloadPositions((current)=>current+1)}>Try again</button>}{!authenticated&&<button className="empty-action" onClick={login}>Sign in to continue</button>}</div>}
    </section>
  </main>;
}

export function MarketApp() {
  const router = useRouter();
  const pathname = usePathname();
  const marketsPage = pathname === "/markets" || pathname === "/";
  const portfolio = pathname === "/portfolio";
  const leaderboard = pathname === "/leaderboard";
  // Authentication is paused until Privy is configured for this deployment.
  const authenticated = false;
  const login = () => notify("Sign in is temporarily unavailable.");
  const logout = () => {};
  const getAccessToken = async () => null;
  const solanaWallets: { address: string; signAndSendTransaction: (args: { transaction: Uint8Array; chain: "solana:devnet" }) => Promise<{ signature: Uint8Array }> }[] = [];
  const searchInput = useRef<HTMLInputElement>(null);
  const [marketList,setMarketList] = useState<Market[]>([]);
  const [marketsLoading,setMarketsLoading] = useState(true);
  const [marketsUnavailable,setMarketsUnavailable] = useState(false);
  const [liveMarkets,setLiveMarkets] = useState(false);
  const [submitting,setSubmitting] = useState(false);
  const [category,setCategory] = useState("All");
  const [filter,setFilter] = useState("All venues");
  const [sort,setSort] = useState("Popular");
  const [search,setSearch] = useState("");
  const [legs,setLegs] = useState<ParlayLeg[]>([]);
  const [stakeAmount,setStakeAmount] = useState("");
  const [signInOpen,setSignInOpen] = useState(false);
  const [selectedMarket,setSelectedMarket] = useState<Market|null>(null);
  const [limit,setLimit] = useState(21);
  const [notice,setNotice] = useState("");

  useEffect(()=>{
    const onShortcut=(event:KeyboardEvent)=>{
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="k") {event.preventDefault();searchInput.current?.focus();}
      if(event.key==="Escape"&&document.activeElement===searchInput.current) {setSearch("");searchInput.current?.blur();}
    };
    window.addEventListener("keydown",onShortcut);
    return ()=>window.removeEventListener("keydown",onShortcut);
  },[]);

  useEffect(()=>{
    if(!marketsPage){setMarketsLoading(false);return;}
    let cancelled=false;
    let latestRequest=0;
    const failClosed=()=>{setMarketList([]);setLiveMarkets(false);setMarketsUnavailable(true);};
    const loadMarkets=async()=>{
      const requestId=++latestRequest;
      try {
        const response=await fetch("/api/market-feed",{cache:"no-store"});
        if(!response.ok) throw new Error("Market catalog unavailable");
        const payload=await response.json() as {markets?:unknown};
        if(!Array.isArray(payload.markets)) throw new Error("Market catalog response is invalid");
        const available=payload.markets.filter(isMarket);
        if(cancelled||requestId!==latestRequest)return;
        setMarketList(available);
        setLiveMarkets(available.length>0);
        setMarketsUnavailable(available.length===0);
      } catch(error) {
        if(!cancelled&&requestId===latestRequest)failClosed();
        throw error;
      }
    };
    void loadMarkets().catch(()=>{}).finally(()=>{if(!cancelled)setMarketsLoading(false);});
    const refresh=window.setInterval(()=>{void loadMarkets().catch(()=>{});},30_000);
    return ()=>{cancelled=true;window.clearInterval(refresh);};
  },[marketsPage]);

  const visibleMarkets = useMemo(() => {
    const query=search.trim().toLowerCase();
    const filtered=marketList.filter((market)=>{
      const matchesCategory=category==="All"||market.category===category;
      const matchesVenue=filter==="All venues"||filter==="Popular"||filter==="Closing soon"||market.venue===filter;
      const matchesSearch=!query||`${market.title} ${market.category} ${market.venue} ${market.outcomes.map((item)=>item.label).join(" ")}`.toLowerCase().includes(query);
      return matchesCategory&&matchesVenue&&matchesSearch;
    });
    if(filter==="Closing soon"||sort==="Closing soon") return [...filtered].sort((a,b)=>Date.parse(a.closeTime)-Date.parse(b.closeTime));
    if(sort==="Popular") return [...filtered].sort((a,b)=>b.volumeSort-a.volumeSort);
    return filtered;
  },[category,filter,search,sort,marketList]);

  function notify(message:string) { setNotice(message); window.setTimeout(()=>setNotice(""),2300); }

  function toggleLeg(market:Market,outcome:string,side:"Yes"|"No") {
    const matches=(leg:ParlayLeg)=>leg.marketId===market.id&&leg.outcome===outcome;
    const existing=legs.some((leg)=>matches(leg)&&leg.side===side);
    if(existing){setLegs((current)=>current.filter((leg)=>!(matches(leg)&&leg.side===side)));return;}
    if(legs.length>=5){notify("Your parlay can have up to 5 legs.");return;}
    if(legs.some((leg)=>leg.marketId===market.id&&leg.outcome!==outcome)){notify("Choose one outcome from each market.");return;}
    const opposite=side==="Yes"?"No":"Yes";
    setLegs((current)=>[...current.filter((leg)=>!(matches(leg)&&leg.side===opposite)),{
      marketId:market.id,title:market.title,outcome,side,
    }]);
  }

  async function submitParlay() {
    if(!authenticated){setSignInOpen(true);return;}
    if(!API_URL){notify("The backend API is not configured.");return;}
    const wallet=solanaWallets[0];
    if(!wallet){notify("Connect or create a Solana wallet with Privy first.");return;}
    if(!liveMarkets){notify("Live market data is unavailable. Try again when the backend is online.");return;}
    setSubmitting(true);
    try {
      const accessToken=await getAccessToken();
      if(!accessToken) throw new Error("Your Privy session expired. Sign in again.");
      const quoteResponse=await fetch(`${API_URL}/api/quote`,{
        method:"POST",
        headers:{authorization:`Bearer ${accessToken}`,"content-type":"application/json"},
        body:JSON.stringify({stake:stakeAmount,solanaOwner:wallet.address,legs:legs.map((leg)=>({marketId:leg.marketId,side:leg.side.toUpperCase()}))}),
      });
      const quoteBody=await quoteResponse.json() as {token?:string;solanaQuote?:SignedSolanaQuote;error?:{message?:string}};
      if(!quoteResponse.ok||!quoteBody.token||!quoteBody.solanaQuote) throw new Error(quoteBody.error?.message??"Could not create a fresh on-chain quote.");
      const [{Connection,PublicKey},{buildAcceptParlayTransaction}]=await Promise.all([import("@solana/web3.js"),import("@/lib/solana-transaction")]);
      const connection=new Connection(RPC_URL,"confirmed");
      const {transaction,parlayAddress}=await buildAcceptParlayTransaction(connection,new PublicKey(wallet.address),quoteBody.solanaQuote);
      const sent=await wallet.signAndSendTransaction({transaction:transaction.serialize({requireAllSignatures:false,verifySignatures:false}),chain:"solana:devnet"});
      const txSignature=encodeBase58(sent.signature);
      const confirmResponse=await fetch(`${API_URL}/api/solana/parlays/confirm`,{
        method:"POST",headers:{authorization:`Bearer ${accessToken}`,"content-type":"application/json"},
        body:JSON.stringify({token:quoteBody.token,transactionSignature:txSignature,parlayAddress:parlayAddress.toBase58()}),
      });
      const confirmed=await confirmResponse.json() as {error?:{message?:string}};
      if(!confirmResponse.ok) throw new Error(confirmed.error?.message??`Transaction sent (${txSignature}) but confirmation could not be recorded.`);
      setLegs([]);
      notify("Parlay accepted on Solana devnet.");
    } catch(error) {
      notify(error instanceof Error?error.message:"Transaction failed.");
    } finally {setSubmitting(false);}
  }

  return <div className="app-shell min-h-screen text-white">
    <header className={cn("topbar",marketsPage&&"markets-topbar")}>
      <Brand />
      <nav className="primary-nav" aria-label="Main navigation">
        <button aria-current={pathname==="/"?"page":undefined} className={pathname==="/"?"primary-link primary-link-active":"primary-link"} onClick={()=>router.push("/")}>Home</button>
        <button aria-current={pathname==="/markets"?"page":undefined} className={pathname==="/markets"?"primary-link primary-link-active":"primary-link"} onClick={()=>router.push("/markets")}>Build Parlay</button>
        <button aria-current={portfolio?"page":undefined} className={portfolio?"primary-link primary-link-active":"primary-link"} onClick={()=>router.push("/portfolio")}>Portfolio</button>
        <button aria-current={leaderboard?"page":undefined} className={leaderboard?"primary-link primary-link-active":"primary-link"} onClick={()=>router.push("/leaderboard")}>Leaderboard</button>
      </nav>
      <DropdownMenu.Root><DropdownMenu.Trigger asChild><button className="mobile-nav-trigger" aria-label="Open navigation"><Menu size={17}/></button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="start" className="menu-content"><DropdownMenu.Item className="menu-item" onSelect={()=>router.push("/")}>Home</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>router.push("/markets")}>Build Parlay</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>router.push("/portfolio")}>Portfolio</DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>router.push("/leaderboard")}>Leaderboard</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
      <label className="header-search"><Search size={15}/><input ref={searchInput} aria-label="Search markets" value={search} onChange={(event)=>{setSearch(event.target.value);if(pathname!=="/markets")router.push("/markets");}} placeholder="Search markets..."/><kbd>âŒ˜K</kbd></label>
      <div className="header-actions">
        <button className="icon-action" aria-label="Notifications" onClick={()=>notify("You're all caught up.")}><Bell size={15}/></button>
        <Button variant="outline" disabled title="Wallet balances are not connected" className="deposit-button">Wallet unavailable</Button>
        <button className="profile-button" aria-label={authenticated?"Sign out":"Sign in"} onClick={()=>authenticated?void logout():setSignInOpen(true)}>{authenticated?"âœ“":"ME"}</button>
      </div>
    </header>

    {!portfolio&&!leaderboard&&<div className={cn("sticky top-[60px] z-30 border-b border-white/[.055] bg-[#050506]/95 backdrop-blur-xl",marketsPage&&"markets-categories")}>
      <CategoryBar active={category} onChange={setCategory} onFilters={setFilter}/>
    </div>}

    <div className={cn("page-layout",marketsPage&&"markets-layout",(portfolio||leaderboard)&&"dashboard-layout")} id="home">
      <main className="main-column">
        {portfolio ? <PortfolioPage notify={notify} login={login} authenticated={authenticated} walletAddress={solanaWallets[0]?.address} getAccessToken={getAccessToken}/> : leaderboard ? <LeaderboardPage/> : <>
          <section className="events-section" aria-labelledby="events-heading">
            <div className="events-heading"><div><h2 id="events-heading">{category==="All"?"Live market catalog":category}</h2><p className="text-xs text-white/45">Listings only. Execution prices and payout require a fresh venue quote.</p></div><DropdownMenu.Root><DropdownMenu.Trigger asChild><Button variant="ghost" size="sm" className="sort-button">{sort}<ArrowDownWideNarrow size={13}/></Button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" className="menu-content"><DropdownMenu.Item className="menu-item" onSelect={()=>setSort("Popular")}>Highest reported volume <Flame size={14}/></DropdownMenu.Item><DropdownMenu.Item className="menu-item" onSelect={()=>setSort("Closing soon")}>Closing soon <ArrowRight size={14}/></DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root></div>
            {marketsLoading?<div className="market-grid" aria-label="Loading markets">{Array.from({length:6},(_,index)=><div className="market-skeleton" key={index}><span/><i/><i/><b/></div>)}</div>:visibleMarkets.length?<div className="market-grid">{visibleMarkets.slice(0,limit).map((market)=><MarketCard key={market.id} market={market} legs={legs.filter((leg)=>leg.marketId===market.id)} onToggle={toggleLeg} onDetails={()=>setSelectedMarket(market)}/>)}</div>:<div className="empty-results"><Search size={20}/><p>{marketsUnavailable?"Live markets are taking a breather.":"No markets match those filters."}</p>{marketsUnavailable?<button onClick={()=>window.location.reload()}>Try again</button>:<button onClick={()=>{setSearch("");setCategory("All");setFilter("All venues");}}>Clear filters</button>}</div>}
            {visibleMarkets.length>limit&&<Button variant="outline" onClick={()=>setLimit((current)=>current+9)} className="load-more">Load More Markets</Button>}
          </section>
        </>}
      </main>
      {!portfolio&&!leaderboard&&<ParlayPanel legs={legs} removeLeg={(leg)=>setLegs((current)=>current.filter((item)=>item!==leg))} clearLegs={()=>setLegs([])} submitParlay={()=>void submitParlay()} submitting={submitting} marketList={marketList} amount={stakeAmount} setAmount={setStakeAmount} tradingAvailable={authenticated&&solanaWallets.length>0}/>}
    </div>

    <footer className={cn("app-footer",marketsPage&&"markets-footer")}><div className="footer-social"><button aria-label="X" onClick={()=>notify("Gargantua on X")}>ð•</button><button aria-label="Discord" onClick={()=>notify("Gargantua community")}>â—‰</button></div><span>Â© 2026 Gargantua. Read the world in probabilities.</span><div className="footer-legal"><button onClick={()=>notify("About Gargantua")}>About</button><i/><button onClick={()=>notify("Documentation")}>Docs</button><i/><button onClick={()=>notify("Terms of Service")}>Terms</button><i/><button onClick={()=>notify("Privacy")}>Privacy</button></div></footer>

    {!portfolio&&!leaderboard&&<><button className="mobile-parlay-button" onClick={()=> (document.getElementById("mobile-slip") as HTMLDialogElement | null)?.showModal()}><span>Your Parlay</span><b>{legs.length}</b></button>
    <dialog id="mobile-slip" className="mobile-slip-dialog" onClick={(event)=>{if(event.target===event.currentTarget)(event.currentTarget as HTMLDialogElement).close();}}><div className="mobile-slip-head"><h2>Bet Slip</h2><button onClick={()=> (document.getElementById("mobile-slip") as HTMLDialogElement | null)?.close()} aria-label="Close"><X size={16}/></button></div><ParlayPanel legs={legs} removeLeg={(leg)=>setLegs((current)=>current.filter((item)=>item!==leg))} clearLegs={()=>setLegs([])} submitParlay={()=>void submitParlay()} submitting={submitting} marketList={marketList} amount={stakeAmount} setAmount={setStakeAmount} tradingAvailable={authenticated&&solanaWallets.length>0}/></dialog></>}

    <AppDialog open={signInOpen} onOpenChange={setSignInOpen} title="Sign in coming soon"><p className="-mt-2 mb-5 text-sm text-white/50">Account and wallet sign-in is temporarily paused while we finish the integration.</p><Button disabled className="mt-1 w-full rounded-full">Authentication unavailable</Button></AppDialog>

    <AppDialog open={Boolean(selectedMarket)} onOpenChange={(open)=>!open&&setSelectedMarket(null)} title={selectedMarket?.title??"Market details"}>{selectedMarket&&<>
      <div className="market-detail-hero">{selectedMarket.imageUrl?<img src={selectedMarket.imageUrl} alt="" />:<EventIcon image={selectedMarket.image}/>}<div className="market-detail-meta"><div className="flex flex-wrap items-center gap-2"><span className="venue-pill">{selectedMarket.venue}</span><span>{selectedMarket.category}</span><span>Â·</span><span>Closes {selectedMarket.date}</span></div><p>{selectedMarket.title}</p></div></div>
      <div className="market-detail-stats"><div><span>24h volume</span><b>{selectedMarket.volume24h??selectedMarket.volume}</b></div><div><span>Total volume</span><b>{selectedMarket.volume}</b></div><div><span>Outcomes</span><b>{selectedMarket.outcomes.length}</b></div></div>
      <div className="market-detail-heading"><b>Choose an outcome</b><span>Prices require a fresh quote</span></div>
      <div className="market-detail-outcomes">{selectedMarket.outcomes.map((outcome)=><div className="market-detail-outcome" key={outcome.label}><div className="flex min-w-0 flex-1 flex-col gap-2"><span className="truncate">{outcome.label}</span></div><Button onClick={()=>toggleLeg(selectedMarket,outcome.label,"Yes")} className="detail-add">Yes</Button><Button onClick={()=>toggleLeg(selectedMarket,outcome.label,"No")} className="detail-add detail-add-no">No</Button></div>)}</div>
      {selectedMarket.description&&<details className="market-rules"><summary>Market rules and resolution</summary><p>{selectedMarket.description}</p></details>}
      <div className="market-detail-footer"><span>Prices are indicative and can move before a quote is accepted.</span>{selectedMarket.sourceUrl&&<a href={selectedMarket.sourceUrl} target="_blank" rel="noreferrer">Open on {selectedMarket.venue}<ExternalLink size={12}/></a>}</div>
    </>}</AppDialog>

    {notice&&<div role="status" className="toast enter">{notice}</div>}
  </div>;
}
