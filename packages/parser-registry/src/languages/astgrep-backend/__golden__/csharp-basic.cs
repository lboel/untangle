using System;
using System.Collections.Generic;
using Sys = System.Text;

namespace Example.Caching
{
    /// <summary>A tiny cache.</summary>
    public interface ICache<T>
    {
        T Get(string key);
    }

    public enum Mode { Read, Write }

    public struct Slot
    {
        public int Size;
    }

    public class Cache : ICache<string>, IDisposable
    {
        private readonly Dictionary<string, string> _items = new();
        public const int Max = 16;

        public Cache(Dictionary<string, string> items)
        {
            _items = items;
        }

        public string Name { get; set; }

        /// <summary>Reads one entry.</summary>
        public string Get(string key)
        {
            if (key == null || key.Length == 0)
            {
                throw new ArgumentNullException(nameof(key));
            }
            else if (_items.Count > Max)
            {
                _items.Clear();
            }

            try
            {
                foreach (var kv in _items)
                {
                    if (kv.Key == key) return kv.Value;
                }
                for (int i = 0; i < Max; i++)
                {
                    while (i < 0) { i++; }
                }
                switch (key)
                {
                    case "a":
                        return "A";
                    case "b":
                        return "B";
                    default:
                        break;
                }
            }
            catch (InvalidOperationException e)
            {
                Console.WriteLine(e.Message);
            }
            return key.Length > 0 ? key : null;
        }

        public void Dispose() => _items.Clear();
    }
}
