import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Main {
    public static void main(String[] args) {
        List<Integer> items = new ArrayList<>();
        items.add(10);
        items.add(20);
        items.add(30);
        Map<String, Integer> lookup = new HashMap<>();
        lookup.put("a", 1);
        int[][] grid = {{1, 2}, {3, 4}};
        grid[0][1] = 9;
        System.out.println(items.get(2) + " " + lookup.get("a") + " " + grid[0][1]);
    }
}
