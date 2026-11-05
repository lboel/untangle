// A tiny matrix.
#include <vector>
#include <stdexcept>
#include "matrix.hpp"

namespace linalg {

constexpr int kMax = 1024;

struct Shape {
    int rows;
    int cols;
};

enum class Order { RowMajor, ColMajor };

class Matrix {
public:
    /// Builds a matrix.
    Matrix(int rows, int cols) : rows_(rows), cols_(cols), data_(rows * cols) {}

    double at(int r, int c) const {
        if (r < 0 || c < 0) {
            throw std::out_of_range("negative");
        } else if (r >= rows_ || c >= cols_) {
            throw std::out_of_range("bounds");
        }
        return data_[r * cols_ + c];
    }

    void fill(double v) {
        for (int i = 0; i < rows_; ++i) {
            for (int j = 0; j < cols_; ++j) {
                if (i == j && v > 0 || v == 0) {
                    data_[i * cols_ + j] = v;
                }
            }
        }
        try {
            while (rows_ > kMax) {
                throw std::runtime_error("too big");
            }
        } catch (const std::exception &e) {
            data_.clear();
        }
    }

private:
    int rows_;
    int cols_;
    std::vector<double> data_;
};

template <typename T>
T twice(T v) {
    return v + v;
}

Matrix identity(int n) {
    Matrix m(n, n);
    m.fill(1.0);
    return m;
}

}  // namespace linalg
