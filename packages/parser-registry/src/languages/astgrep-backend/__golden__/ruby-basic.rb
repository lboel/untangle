# frozen_string_literal: true

require 'json'
require_relative 'helper'

# A report builder.
module Reporting
  MAX = 10

  class Report
    attr_reader :rows

    def initialize(rows)
      @rows = rows
    end

    # Renders the report.
    def render(format = :text)
      raise ArgumentError, 'no rows' if @rows.empty?

      out = []
      @rows.each_with_index do |row, i|
        next if row.nil?
        if i.zero?
          out << header(row)
        elsif i > MAX
          break
        else
          out << body(row)
        end
      end

      case format
      when :json then JSON.dump(out)
      when :text then out.join("\n")
      else
        raise "unknown #{format}"
      end
    rescue StandardError => e
      warn(e.message)
      ''
    end

    private

    def header(row)
      row.to_s.upcase
    end

    def body(row)
      row.to_s if row && !row.empty? || row == 0
    end

    def self.build(rows)
      new(rows)
    end
  end

  def self.quick(rows)
    Report.build(rows).render
  end
end
