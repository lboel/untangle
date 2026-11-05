// Package worker drains a queue.
package worker

import (
	"context"
	"errors"
	"fmt"
	ts "time"
)

// ErrClosed is returned once the pool is closed.
var ErrClosed = errors.New("closed")

const maxRetries = 3

// Job is one unit of work.
type Job struct {
	ID      string
	Payload []byte
}

// Runner runs jobs.
type Runner interface {
	Run(ctx context.Context, j Job) error
}

type pool struct {
	jobs   chan Job
	runner Runner
}

// NewPool builds a pool.
func NewPool(r Runner, size int) *pool {
	return &pool{jobs: make(chan Job, size), runner: r}
}

// Drain consumes jobs until the context ends.
func (p *pool) Drain(ctx context.Context) error {
	for {
		select {
		case j, ok := <-p.jobs:
			if !ok {
				return ErrClosed
			}
			if err := p.runOne(ctx, j); err != nil && !errors.Is(err, ErrClosed) {
				return fmt.Errorf("job %s: %w", j.ID, err)
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func (p *pool) runOne(ctx context.Context, j Job) error {
	for attempt := 0; attempt < maxRetries; attempt++ {
		err := p.runner.Run(ctx, j)
		if err == nil {
			return nil
		}
		switch {
		case errors.Is(err, ErrClosed):
			return err
		default:
			ts.Sleep(ts.Millisecond)
		}
	}
	return ErrClosed
}

func describe(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case int, int64:
		return fmt.Sprint(x)
	default:
		return "?"
	}
}

func each(items []Job, fn func(Job) bool) int {
	n := 0
	for i, it := range items {
		if i > 0 && fn(it) || len(it.ID) == 0 {
			n++
		}
	}
	go func() {
		defer func() { _ = recover() }()
		_ = n
	}()
	return n
}
