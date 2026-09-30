import java.util.ArrayList;
import java.util.List;

public class Main {
    public static void main(String[] args) {
        List<Integer> first = new ArrayList<>(List.of(1, 2, 3));
        List<Integer> second = first;
        second.add(4);
        System.out.println(first.size());
    }
}
