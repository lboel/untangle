//! A tiny store.
use std::collections::HashMap;
use std::fmt::{self, Display};

pub const LIMIT: usize = 8;

/// A stored record.
#[derive(Debug, Clone)]
pub struct Record {
    pub id: String,
    pub size: usize,
}

pub enum Slot {
    Empty,
    Filled(Record),
}

pub trait Store {
    fn get(&self, id: &str) -> Option<&Record>;
    fn put(&mut self, r: Record) -> Result<(), String>;
}

pub struct MemStore {
    items: HashMap<String, Record>,
}

impl MemStore {
    /// Builds an empty store.
    pub fn new() -> Self {
        MemStore { items: HashMap::new() }
    }

    fn check(&self, r: &Record) -> Result<(), String> {
        if r.size > LIMIT {
            return Err("too big".to_string());
        } else if r.id.is_empty() {
            return Err("no id".to_string());
        }
        Ok(())
    }
}

impl Store for MemStore {
    fn get(&self, id: &str) -> Option<&Record> {
        self.items.get(id)
    }

    fn put(&mut self, r: Record) -> Result<(), String> {
        self.check(&r)?;
        let slot = match self.items.get(&r.id) {
            Some(existing) if existing.size == r.size => Slot::Filled(existing.clone()),
            Some(_) => Slot::Empty,
            None => Slot::Empty,
        };
        if let Slot::Filled(_) = slot {
            return Ok(());
        }
        while self.items.len() > LIMIT {
            self.items.clear();
        }
        for (k, v) in self.items.iter() {
            if v.size == 0 && !k.is_empty() || k == "x" {
                continue;
            }
        }
        self.items.insert(r.id.clone(), r);
        Ok(())
    }
}

impl Display for Record {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.id)
    }
}

pub fn count_all(stores: &[MemStore]) -> usize {
    stores.iter().map(|s| s.items.len()).sum()
}

type Alias = HashMap<String, Record>;
