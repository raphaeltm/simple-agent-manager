package calc

import "fmt"

// FormatSum uses ComputeSum to format an addition result.
func FormatSum(a, b int) string {
	result := ComputeSum(a, b)
	return fmt.Sprintf("%d + %d = %d", a, b, result)
}

// FormatProduct uses ComputeProduct to format a multiplication result.
func FormatProduct(a, b int) string {
	result := ComputeProduct(a, b)
	return fmt.Sprintf("%d * %d = %d", a, b, result)
}
