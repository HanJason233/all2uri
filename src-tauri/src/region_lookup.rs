use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager};
use tokio::{net::lookup_host, task::JoinSet};
use url::Url;

const MAX_CONCURRENCY: usize = 8;
const MAX_GEOIP_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_GEOIP_FIELD_BYTES: u64 = 32 * 1024 * 1024;
const CLOUDFLARE_CIDRS: &[&str] = &[
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionLookupNode {
    pub id: String,
    pub server: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegionLookupResult {
    pub id: String,
    pub country_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareLookupNode {
    pub id: String,
    pub server: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudflareLookupResult {
    pub id: String,
    pub is_cloudflare: Option<bool>,
}

#[derive(Clone, Copy)]
enum LookupMethod {
    LocalGeoIp,
    RemoteApi,
}

#[tauri::command]
pub async fn lookup_node_regions(
    app: tauri::AppHandle,
    nodes: Vec<RegionLookupNode>,
    lookup_method: String,
    geo_ip_database_path: Option<String>,
) -> Vec<RegionLookupResult> {
    let method = match lookup_method.as_str() {
        "LOCAL_GEOIP" => LookupMethod::LocalGeoIp,
        "REMOTE_API" => LookupMethod::RemoteApi,
        _ => {
            return nodes
                .into_iter()
                .map(|node| RegionLookupResult {
                    id: node.id,
                    country_code: None,
                })
                .collect();
        }
    };

    let database = if matches!(method, LookupMethod::LocalGeoIp) {
        let selected_database = geo_ip_database_path
            .as_deref()
            .map(Path::new)
            .filter(|path| path.is_file())
            .and_then(load_geoip_database);
        let bundled_database = app
            .path()
            .resolve("resources/geoip.dat", BaseDirectory::Resource)
            .ok()
            .and_then(|path| load_geoip_database(&path));
        selected_database.or(bundled_database).map(Arc::new)
    } else {
        None
    };
    let client = if matches!(method, LookupMethod::RemoteApi) {
        Client::builder()
            .timeout(Duration::from_secs(5))
            .user_agent(concat!("all2uri/", env!("CARGO_PKG_VERSION")))
            .build()
            .ok()
    } else {
        None
    };

    let mut tasks = JoinSet::new();
    let mut results: Vec<Option<RegionLookupResult>> = (0..nodes.len()).map(|_| None).collect();
    for (index, node) in nodes.iter().enumerate() {
        let id = node.id.clone();
        let server = node.server.clone();
        let database = database.clone();
        let client = client.clone();
        tasks.spawn(async move {
            let country_code = match method {
                LookupMethod::LocalGeoIp => {
                    let Some(database) = database else {
                        return (
                            index,
                            RegionLookupResult {
                                id,
                                country_code: None,
                            },
                        );
                    };
                    let addresses = resolve_public_addresses(&server).await;
                    addresses.into_iter().find_map(|address| database.lookup(address))
                }
                LookupMethod::RemoteApi => {
                    let addresses = resolve_public_addresses(&server).await;
                    match (client, addresses.into_iter().next()) {
                        (Some(client), Some(address)) => resolve_remote_country(&client, address).await,
                        _ => None,
                    }
                }
            };
            (index, RegionLookupResult { id, country_code })
        });

        if tasks.len() >= MAX_CONCURRENCY {
            if let Some(Ok((index, result))) = tasks.join_next().await {
                results[index] = Some(result);
            }
        }
    }

    while let Some(result) = tasks.join_next().await {
        if let Ok((index, value)) = result {
            results[index] = Some(value);
        }
    }
    results.into_iter().flatten().collect()
}

/// 检查节点服务器入口地址是否命中 Cloudflare 官方网段，不检查代理出口地址。
#[tauri::command]
pub async fn lookup_cloudflare_entries(
    nodes: Vec<CloudflareLookupNode>,
) -> Vec<CloudflareLookupResult> {
    let mut nodes_by_server: HashMap<String, Vec<(usize, String)>> = HashMap::new();
    for (index, node) in nodes.iter().enumerate() {
        nodes_by_server
            .entry(node.server.clone())
            .or_default()
            .push((index, node.id.clone()));
    }

    let mut tasks = JoinSet::new();
    let mut results: Vec<Option<CloudflareLookupResult>> = (0..nodes.len()).map(|_| None).collect();
    for (server, indexed_nodes) in nodes_by_server {
        tasks.spawn(async move {
            let addresses = resolve_public_addresses(&server).await;
            let is_cloudflare = (!addresses.is_empty())
                .then(|| addresses.into_iter().any(is_cloudflare_address));
            indexed_nodes
                .into_iter()
                .map(|(index, id)| {
                    (index, CloudflareLookupResult { id, is_cloudflare })
                })
                .collect::<Vec<_>>()
        });

        if tasks.len() >= MAX_CONCURRENCY {
            if let Some(Ok(batch)) = tasks.join_next().await {
                for (index, result) in batch {
                    results[index] = Some(result);
                }
            }
        }
    }

    while let Some(batch) = tasks.join_next().await {
        if let Ok(batch) = batch {
            for (index, result) in batch {
                results[index] = Some(result);
            }
        }
    }
    results.into_iter().flatten().collect()
}

fn is_cloudflare_address(address: IpAddr) -> bool {
    let address = match address {
        IpAddr::V6(value) => value
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(value)),
        value => value,
    };
    cloudflare_ranges().iter().any(|range| range.contains(address))
}

#[derive(Clone, Copy)]
struct IpRange {
    network: IpAddr,
    prefix: u8,
}

impl IpRange {
    fn contains(self, address: IpAddr) -> bool {
        match (address, self.network) {
            (IpAddr::V4(address), IpAddr::V4(network)) if self.prefix <= 32 => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - u32::from(self.prefix))
                };
                (u32::from(address) & mask) == (u32::from(network) & mask)
            }
            (IpAddr::V6(address), IpAddr::V6(network)) if self.prefix <= 128 => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - u32::from(self.prefix))
                };
                (u128::from(address) & mask) == (u128::from(network) & mask)
            }
            _ => false,
        }
    }
}

fn cloudflare_ranges() -> &'static [IpRange] {
    static RANGES: OnceLock<Vec<IpRange>> = OnceLock::new();
    RANGES.get_or_init(|| {
        CLOUDFLARE_CIDRS
            .iter()
            .filter_map(|cidr| {
                let (network, prefix) = cidr.split_once('/')?;
                let network = network.parse::<IpAddr>().ok()?;
                let prefix = prefix.parse::<u8>().ok()?;
                let max_prefix = if network.is_ipv4() { 32 } else { 128 };
                (prefix <= max_prefix).then_some(IpRange { network, prefix })
            })
            .collect()
    })
}

async fn resolve_public_addresses(server: &str) -> Vec<IpAddr> {
    let host = server.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() || is_local_name(host) {
        return Vec::new();
    }

    let addresses: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, 443)]
    } else {
        match lookup_host((host, 443)).await {
            Ok(addresses) => addresses.collect(),
            Err(_) => return Vec::new(),
        }
    };

    let mut seen = HashSet::new();
    addresses
        .into_iter()
        .map(|address| address.ip())
        .filter(|address| !is_special_ip(*address) && seen.insert(*address))
        .collect()
}

async fn resolve_remote_country(client: &Client, address: IpAddr) -> Option<String> {
    static COUNTRY_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

    let ip = address.to_string();
    let cache = COUNTRY_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(country) = cache.lock().ok()?.get(&ip).cloned() {
        return Some(country);
    }

    let mut url = Url::parse("https://ipwho.is/").ok()?;
    url.path_segments_mut().ok()?.push(&ip);
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.text().await.ok()?;
    let value: serde_json::Value = serde_json::from_str(&body).ok()?;
    if value.get("success")?.as_bool()? != true {
        return None;
    }
    let code = normalize_country_code(value.get("country_code")?.as_str()?)?;
    if let Ok(mut cache) = cache.lock() {
        cache.insert(ip, code.clone());
    }
    Some(code)
}

fn normalize_country_code(value: &str) -> Option<String> {
    let code = value.trim();
    (code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_alphabetic()))
        .then(|| code.to_ascii_uppercase())
}

fn is_local_name(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    ["localhost", ".localhost", ".local", ".lan", ".internal", ".home.arpa"]
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(suffix))
}

fn is_special_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(value) => {
            let [a, b, c, _] = value.octets();
            value.is_private()
                || value.is_loopback()
                || value.is_link_local()
                || value.is_broadcast()
                || value.is_unspecified()
                || value.is_multicast()
                || a == 0
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 88 && c == 99)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 240
        }
        IpAddr::V6(value) => {
            if let Some(ipv4) = value.to_ipv4_mapped() {
                return is_special_ip(IpAddr::V4(ipv4));
            }
            let segments = value.segments();
            let global_unicast = segments[0] & 0xe000 == 0x2000;
            !global_unicast
                || value.is_loopback()
                || value.is_unspecified()
                || value.is_unique_local()
                || value.is_unicast_link_local()
                || value.is_multicast()
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                || (segments[0] == 0x2001 && segments[1] == 0x0000)
                || (segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0)
                || (segments[0] == 0x2001 && segments[1] & 0xfff0 == 0x0010)
                || (segments[0] == 0x2001 && segments[1] & 0xfff0 == 0x0020)
                || segments[0] == 0x2002
                || (segments[0] == 0x3fff && segments[1] & 0xf000 == 0)
        }
    }
}

struct GeoIpDatabase {
    ranges: HashMap<(Vec<u8>, u8), String>,
}

impl GeoIpDatabase {
    fn lookup(&self, address: IpAddr) -> Option<String> {
        let raw = match address {
            IpAddr::V4(value) => value.octets().to_vec(),
            IpAddr::V6(value) => {
                let bytes = value.octets();
                if bytes[..10].iter().all(|byte| *byte == 0) && bytes[10..12] == [0xff, 0xff] {
                    bytes[12..].to_vec()
                } else {
                    bytes.to_vec()
                }
            }
        };
        for prefix in (0..=raw.len() * 8).rev() {
            if let Some(country) = self
                .ranges
                .get(&(masked_address(&raw, prefix as u8), prefix as u8))
            {
                return Some(country.clone());
            }
        }
        None
    }

    fn add_range(&mut self, address: &[u8], prefix: u8, country: String) {
        self.ranges
            .insert((masked_address(address, prefix), prefix), country);
    }
}

fn load_geoip_database(path: &Path) -> Option<GeoIpDatabase> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_GEOIP_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    parse_geoip_database(&bytes)
}

fn parse_geoip_database(bytes: &[u8]) -> Option<GeoIpDatabase> {
    let mut database = GeoIpDatabase { ranges: HashMap::new() };
    let mut position = 0;
    while position < bytes.len() {
        let tag = read_varint(bytes, &mut position)? as u32;
        let field = tag >> 3;
        let wire_type = tag & 7;
        if field == 1 && wire_type == 2 {
            let geo_ip = read_length_delimited(bytes, &mut position)?;
            read_geo_ip(geo_ip, &mut database)?;
        } else {
            skip_field(bytes, &mut position, wire_type)?;
        }
    }
    Some(database)
}

fn read_geo_ip(bytes: &[u8], database: &mut GeoIpDatabase) -> Option<()> {
    let mut position = 0;
    let mut country = None;
    let mut reverse_match = false;
    let mut cidrs = Vec::new();
    while position < bytes.len() {
        let tag = read_varint(bytes, &mut position)? as u32;
        let field = tag >> 3;
        let wire_type = tag & 7;
        match (field, wire_type) {
            (1, 2) => {
                country = std::str::from_utf8(read_length_delimited(bytes, &mut position)?)
                    .ok()
                    .map(|value| value.to_string());
            }
            (2, 2) => cidrs.push(read_length_delimited(bytes, &mut position)?),
            (3, 0) => reverse_match = read_varint(bytes, &mut position)? != 0,
            _ => skip_field(bytes, &mut position, wire_type)?,
        }
    }
    if reverse_match {
        return Some(());
    }
    let country = country.as_deref().and_then(normalize_country_code);
    let Some(country) = country else { return Some(()) };
    for cidr in cidrs {
        if let Some((address, prefix)) = read_cidr(cidr) {
            database.add_range(&address, prefix, country.clone());
        }
    }
    Some(())
}

fn read_cidr(bytes: &[u8]) -> Option<(Vec<u8>, u8)> {
    let mut position = 0;
    let mut address = None;
    let mut prefix = None;
    while position < bytes.len() {
        let tag = read_varint(bytes, &mut position)? as u32;
        let field = tag >> 3;
        let wire_type = tag & 7;
        match (field, wire_type) {
            (1, 2) => address = Some(read_length_delimited(bytes, &mut position)?.to_vec()),
            (2, 0) => prefix = Some(read_varint(bytes, &mut position)?),
            _ => skip_field(bytes, &mut position, wire_type)?,
        }
    }
    let address = address?;
    let prefix = u8::try_from(prefix?).ok()?;
    if !matches!(address.len(), 4 | 16) || prefix as usize > address.len() * 8 {
        return None;
    }
    Some((address, prefix))
}

fn read_varint(bytes: &[u8], position: &mut usize) -> Option<u64> {
    let mut result = 0_u64;
    for index in 0..10 {
        let byte = *bytes.get(*position)?;
        *position += 1;
        let part = u64::from(byte & 0x7f);
        if index == 9 && part > 1 {
            return None;
        }
        result |= part << (index * 7);
        if byte & 0x80 == 0 {
            return Some(result);
        }
    }
    None
}

fn read_length_delimited<'a>(bytes: &'a [u8], position: &mut usize) -> Option<&'a [u8]> {
    let length = read_varint(bytes, position)?;
    if length > MAX_GEOIP_FIELD_BYTES {
        return None;
    }
    let length = usize::try_from(length).ok()?;
    let end = (*position).checked_add(length)?;
    let value = bytes.get(*position..end)?;
    *position = end;
    Some(value)
}

fn skip_field(bytes: &[u8], position: &mut usize, wire_type: u32) -> Option<()> {
    match wire_type {
        0 => { read_varint(bytes, position)?; }
        1 => skip_bytes(bytes, position, 8)?,
        2 => {
            let length = read_varint(bytes, position)?;
            if length > MAX_GEOIP_FIELD_BYTES { return None; }
            skip_bytes(bytes, position, usize::try_from(length).ok()?)?;
        }
        5 => skip_bytes(bytes, position, 4)?,
        _ => return None,
    }
    Some(())
}

fn skip_bytes(bytes: &[u8], position: &mut usize, count: usize) -> Option<()> {
    let end = (*position).checked_add(count)?;
    if end > bytes.len() {
        return None;
    }
    *position = end;
    Some(())
}

fn masked_address(address: &[u8], prefix: u8) -> Vec<u8> {
    let mut masked = address.to_vec();
    let full_bytes = usize::from(prefix / 8);
    let remaining_bits = prefix % 8;
    if remaining_bits > 0 && full_bytes < masked.len() {
        masked[full_bytes] &= 0xff << (8 - remaining_bits);
    }
    let zero_from = full_bytes + usize::from(remaining_bits > 0);
    let zero_from = zero_from.min(masked.len());
    masked[zero_from..].fill(0);
    masked
}
